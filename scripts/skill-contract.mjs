// Shared checks for skill/SKILL.md: the SKILL.md format accepted by Claude Code and Codex,
// and agreement between the tools the skill documents and the daemon's tool contract.
// Zero dependencies, Node 22 or newer.
import { readFileSync } from 'node:fs';

export const SKILL_NAME = 'pairpost';

// Frontmatter keys accepted by the Codex skill validator. Claude Code accepts the same set.
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata']);
const NESTED_KEYS = new Set(['metadata', 'allowed-tools']);
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const RESERVED_NAME_WORDS = ['anthropic', 'claude'];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// Parse the leading YAML frontmatter. Supports the subset skills use: single-line scalar
// values, plus indented lines under `metadata` and `allowed-tools`.
export function parseFrontmatter(text) {
  const errors = [];
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text.replace(/\r\n/g, '\n'));
  if (!match) return { data: null, body: text, errors: ['SKILL.md must start with YAML frontmatter between --- lines'] };
  const data = {};
  let current = null;
  for (const line of match[1].split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      if (!current || !NESTED_KEYS.has(current)) errors.push(`frontmatter: unexpected indented line: ${line.trim()}`);
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!kv) {
      errors.push(`frontmatter: cannot parse line: ${line}`);
      continue;
    }
    current = kv[1];
    if (Object.hasOwn(data, current)) errors.push(`frontmatter: duplicate key: ${current}`);
    data[current] = kv[2] === undefined ? '' : unquote(kv[2]);
  }
  return { data, body: text.slice(match[0].length), errors };
}

// Validate SKILL.md against the format both hosts load.
export function validateSkillFormat(text, { expectedName = SKILL_NAME } = {}) {
  const { data, errors } = parseFrontmatter(text);
  if (!data) return errors;
  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`frontmatter: unexpected key "${key}" (allowed: ${[...ALLOWED_KEYS].join(', ')})`);
  }
  const name = (data.name ?? '').trim();
  if (!name) errors.push('frontmatter: missing "name"');
  else {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      errors.push(`frontmatter: name "${name}" must be hyphen-case: lowercase letters, digits and single hyphens`);
    }
    if (name.length > MAX_NAME) errors.push(`frontmatter: name is ${name.length} characters, maximum is ${MAX_NAME}`);
    for (const word of RESERVED_NAME_WORDS) {
      if (name.includes(word)) errors.push(`frontmatter: name must not contain the reserved word "${word}"`);
    }
    if (name !== expectedName) errors.push(`frontmatter: name "${name}" must equal the skill folder name "${expectedName}"`);
  }
  const description = (data.description ?? '').trim();
  if (!description) errors.push('frontmatter: missing "description"');
  else {
    if (description.length > MAX_DESCRIPTION) {
      errors.push(`frontmatter: description is ${description.length} characters, maximum is ${MAX_DESCRIPTION}`);
    }
    if (/[<>]/.test(description)) errors.push('frontmatter: description must not contain < or >');
  }
  return errors;
}

function sectionLines(body, heading) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

// Extract the documented tools from the "## Tools" section: each "### `name`" heading, the
// parameter bullets that follow its "Parameters" line, and whether they are all optional.
export function parseSkillTools(text) {
  const { body } = parseFrontmatter(text);
  const lines = sectionLines(body, '## Tools');
  if (!lines) return { tools: [], errors: ['SKILL.md has no "## Tools" section'] };
  const tools = [];
  const errors = [];
  let tool = null;
  let state = 'none';
  for (const line of lines) {
    const heading = /^### `([^`]+)`\s*$/.exec(line);
    if (heading) {
      tool = { name: heading[1], params: [], required: [], hasParameters: false };
      tools.push(tool);
      state = 'none';
      continue;
    }
    if (/^### /.test(line)) {
      errors.push(`tool heading must be a single code span: ${line.trim()}`);
      tool = null;
      continue;
    }
    if (!tool) continue;
    if (/^Parameters\b/.test(line)) {
      tool.hasParameters = true;
      tool.optional = /optional/i.test(line);
      state = /none/i.test(line) ? 'done' : 'params';
      continue;
    }
    if (state !== 'params') continue;
    const bullet = /^- `([^`]+)`:/.exec(line);
    if (bullet) {
      tool.params.push(bullet[1]);
      continue;
    }
    if (line.trim() === '' && tool.params.length === 0) continue;
    state = 'done';
  }
  for (const t of tools) {
    if (!t.hasParameters) errors.push(`tool "${t.name}": no "Parameters" line`);
    t.required = t.optional ? [] : [...t.params];
    delete t.optional;
    delete t.hasParameters;
  }
  return { tools, errors };
}

// Extract name, parameter names and required parameters from the daemon's tool contract.
export function parseToolManifest(json) {
  const manifest = typeof json === 'string' ? JSON.parse(json) : json;
  if (!manifest || !Array.isArray(manifest.tools)) throw new Error('tool manifest must have a "tools" array');
  return manifest.tools.map((t) => {
    if (typeof t.name !== 'string' || !t.name) throw new Error('every tool in the manifest needs a name');
    const props = t.inputSchema?.properties ?? {};
    return { name: t.name, params: Object.keys(props), required: [...(t.inputSchema?.required ?? [])] };
  });
}

function setDiff(a, b) {
  const sb = new Set(b);
  return a.filter((x) => !sb.has(x));
}

// Count words in the prose ("exactly these four tools", "four read-only tools") must match.
function checkCountWords(body, count) {
  const errors = [];
  for (const m of body.matchAll(/\b(?:exactly these|gives you) ([a-z]+)(?: read-only)? tools\b/gi)) {
    const n = NUMBER_WORDS.indexOf(m[1].toLowerCase());
    if (n !== -1 && n !== count) errors.push(`skill text says "${m[0]}" but the daemon exposes ${count} tools`);
  }
  return errors;
}

// Compare the skill text with the tool manifest. Returns a list of disagreements.
export function compareSkillWithManifest(skillText, manifestJson) {
  const { tools: documented, errors } = parseSkillTools(skillText);
  const daemon = parseToolManifest(manifestJson);
  const out = [...errors];
  const docNames = documented.map((t) => t.name);
  const daemonNames = daemon.map((t) => t.name);
  for (const dup of docNames.filter((n, i) => docNames.indexOf(n) !== i)) out.push(`skill documents "${dup}" twice`);
  for (const name of setDiff(daemonNames, docNames)) out.push(`daemon tool "${name}" is missing from SKILL.md`);
  for (const name of setDiff(docNames, daemonNames)) out.push(`SKILL.md documents "${name}", which the daemon does not expose`);
  for (const d of daemon) {
    const s = documented.find((t) => t.name === d.name);
    if (!s) continue;
    for (const p of setDiff(d.params, s.params)) out.push(`${d.name}: daemon parameter "${p}" is not documented`);
    for (const p of setDiff(s.params, d.params)) out.push(`${d.name}: documented parameter "${p}" is not accepted by the daemon`);
    const shared = d.params.filter((p) => s.params.includes(p));
    for (const p of shared) {
      const daemonReq = d.required.includes(p);
      const docReq = s.required.includes(p);
      if (daemonReq !== docReq) {
        out.push(`${d.name}: parameter "${p}" is ${daemonReq ? 'required' : 'optional'} in the daemon but ${docReq ? 'required' : 'optional'} in SKILL.md`);
      }
    }
  }
  out.push(...checkCountWords(parseFrontmatter(skillText).body, daemon.length));
  return out;
}

// Run every check on files. Returns { errors, toolCount }.
export function checkSkillFiles(skillPath, manifestPath, options) {
  const skillText = readFileSync(skillPath, 'utf8');
  const errors = validateSkillFormat(skillText, options);
  let toolCount = 0;
  try {
    const manifestText = readFileSync(manifestPath, 'utf8');
    toolCount = parseToolManifest(manifestText).length;
    errors.push(...compareSkillWithManifest(skillText, manifestText));
  } catch (err) {
    errors.push(`tool manifest ${manifestPath}: ${err.message}`);
  }
  return { errors, toolCount };
}
