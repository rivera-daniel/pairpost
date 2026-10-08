#!/usr/bin/env node
// Fail when skill/SKILL.md breaks the SKILL.md format used by Claude Code and Codex, or when
// the tools it documents disagree with the daemon's tool contract in daemon/tools.json.
// Usage: node scripts/check-skill.mjs [--skill <SKILL.md>] [--tools <tools.json>]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkSkillFiles } from './skill-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    skill: { type: 'string', default: path.join(root, 'skill', 'SKILL.md') },
    tools: { type: 'string', default: path.join(root, 'daemon', 'tools.json') },
  },
});

const { errors, toolCount } = checkSkillFiles(values.skill, values.tools);
if (errors.length > 0) {
  for (const e of errors) console.error(`check-skill: ${e}`);
  console.error('check-skill: FAILED');
  process.exit(1);
}
console.log(`check-skill: ok (${toolCount} tools match)`);
