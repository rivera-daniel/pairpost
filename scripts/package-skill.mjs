#!/usr/bin/env node
// Build the distributable skill: dist/pairpost/ (a folder to copy into a host's skills
// directory), dist/pairpost-skill-<version>.zip and a .sha256 file next to it.
// Runs the skill checks first and refuses to package when they fail. The zip is reproducible:
// fixed entry order and timestamps, so the same sources give the same checksum.
// Usage: node scripts/package-skill.mjs [--out <dir>]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';
import { SKILL_NAME, checkSkillFiles } from './skill-contract.mjs';

// Files that make up the skill folder: [source relative to the repository, name inside the folder].
const SKILL_FILES = [
  ['skill/SKILL.md', 'SKILL.md'],
  ['LICENSE', 'LICENSE'],
];

// 1980-01-01 00:00:00, the earliest MS-DOS timestamp.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function zipArchive(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix, spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

export function readVersion(root) {
  const version = readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`VERSION "${version}" is not a semantic version`);
  return version;
}

// Package the skill found under `root` into `outDir`. Throws when the skill checks fail.
export function packageSkill({ root, outDir = path.join(root, 'dist') }) {
  const { errors } = checkSkillFiles(path.join(root, 'skill', 'SKILL.md'), path.join(root, 'daemon', 'tools.json'));
  if (errors.length > 0) throw new Error(`skill checks failed, not packaging:\n${errors.join('\n')}`);
  const version = readVersion(root);

  const folder = path.join(outDir, SKILL_NAME);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const entries = SKILL_FILES.map(([src, dest]) => {
    const data = readFileSync(path.join(root, src));
    writeFileSync(path.join(folder, dest), data);
    return { name: `${SKILL_NAME}/${dest}`, data };
  });

  const archiveName = `${SKILL_NAME}-skill-${version}.zip`;
  const zipPath = path.join(outDir, archiveName);
  const zip = zipArchive(entries);
  writeFileSync(zipPath, zip);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const checksumPath = `${zipPath}.sha256`;
  // sha256sum format, relative name, so `sha256sum -c` works from the output directory.
  writeFileSync(checksumPath, `${sha256}  ${archiveName}\n`);
  return { folder, zipPath, checksumPath, sha256, version, files: entries.map((e) => e.name) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { values } = parseArgs({ options: { out: { type: 'string', default: path.join(root, 'dist') } } });
  try {
    const result = packageSkill({ root, outDir: path.resolve(values.out) });
    console.log(`package-skill: ${path.relative(process.cwd(), result.zipPath)}`);
    console.log(`package-skill: sha256 ${result.sha256}`);
    console.log(`package-skill: folder ${path.relative(process.cwd(), result.folder)}`);
  } catch (err) {
    console.error(`package-skill: ${err.message}`);
    process.exit(1);
  }
}
