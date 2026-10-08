import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertReader, checkTypedAndInert } from './reader.mjs';

export function validateCorpus(cases) {
  if (!Array.isArray(cases) || cases.length === 0) throw new TypeError('Corpus must be a nonempty array.');
  const ids = new Set();
  for (const entry of cases) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 4
      || !['id', 'category', 'input', 'expected'].every(key => Object.hasOwn(entry, key))
      || typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.id)
      || typeof entry.category !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.category)
      || ids.has(entry.id) || typeof entry.input !== 'string'
      || !checkTypedAndInert(entry.expected).pass) {
      throw new TypeError('Every corpus case needs a unique id, category, serialized input, and typed inert expectation.');
    }
    ids.add(entry.id);
  }
  return cases;
}

export async function loadReader(filename) {
  const module = await import(pathToFileURL(path.resolve(filename)).href);
  return assertReader(module.reader);
}

/** @param {import('./reader.mjs').Reader} reader */
export async function runConformance(reader, cases) {
  assertReader(reader);
  validateCorpus(cases);
  const categories = new Map();
  for (const entry of cases) {
    if (!categories.has(entry.category)) categories.set(entry.category, { category: entry.category, failures: 0, cases: [] });
    const group = categories.get(entry.category);
    let result;
    try {
      const output = await reader.read(entry.input);
      const checked = checkTypedAndInert(output);
      const rules = checked.pass && !isDeepStrictEqual(output, entry.expected) ? ['output-mismatch'] : checked.rules;
      result = { id: entry.id, pass: rules.length === 0, rules };
      if (result.pass) result.output = output;
    } catch {
      result = { id: entry.id, pass: false, rules: ['reader-error'] };
    }
    if (!result.pass) group.failures += 1;
    group.cases.push(result);
  }
  const groups = [...categories.values()];
  const failures = groups.reduce((sum, group) => sum + group.failures, 0);
  return { total: cases.length, passed: cases.length - failures, failures, categories: groups };
}

export function formatReport(report) {
  const lines = [];
  for (const group of report.categories) {
    lines.push(`${group.category}: ${group.failures} failure(s)`);
    for (const result of group.cases) {
      lines.push(result.pass
        ? `  PASS ${result.id} typed inert ${JSON.stringify(result.output)}`
        : `  FAIL ${result.id}: ${result.rules.join(', ')}`);
    }
  }
  lines.push(`Total: ${report.total}, passed: ${report.passed}, failures: ${report.failures}`);
  return lines.join('\n');
}

const usage = 'Usage: node conformance/runner.mjs --reader <local-module.mjs> [--corpus <cases.json>] [--json]';

export async function main(args) {
  let readerPath;
  let corpusPath = fileURLToPath(new URL('./corpus/seed.json', import.meta.url));
  let json = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (seen.has(option)) throw new TypeError(usage);
    seen.add(option);
    if (option === '--json') {
      json = true;
    } else if ((option === '--reader' || option === '--corpus')
      && args[index + 1] && !args[index + 1].startsWith('--')) {
      const value = args[++index];
      if (option === '--reader') readerPath = value;
      else corpusPath = value;
    } else {
      throw new TypeError(usage);
    }
  }
  if (!readerPath) throw new TypeError(usage);
  const cases = validateCorpus(JSON.parse(await readFile(corpusPath, 'utf8')));
  const reader = await loadReader(readerPath);
  const report = await runConformance(reader, cases);
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.failures === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof TypeError && error.message === usage ? usage : 'Conformance setup failed. Check the reader module and corpus format.');
    process.exitCode = 2;
  }
}
