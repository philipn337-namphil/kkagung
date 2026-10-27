import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const files = ['backend/package.json', 'backend/package-lock.json',
  'frontend/app.js', 'frontend/server.js', 'frontend/index.html', 'frontend/styles.css', 'frontend/package.json'];
for (const directory of ['backend/src', 'backend/prisma', 'backend/tests', 'infra/security']) {
  const walk = path => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (['evidence', 'node_modules', 'dist'].includes(item.name)) continue;
      const full = resolve(path, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile() && /\.(ts|mjs|prisma|sql)$/.test(item.name)) files.push(relative(root, full).replaceAll('\\', '/'));
    }
  };
  walk(resolve(root, directory));
}
const evidence = { recordedAt: new Date().toISOString(),
  baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  mode: 'Hash of working source and tests; no environment files, dependency contents or photo data read',
  sourceHashes: Object.fromEntries([...new Set(files)].sort().map(path =>
    [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])) };
writeFileSync(resolve(root, 'infra/security/evidence/source-provenance-20261027.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(`Source provenance: ${Object.keys(evidence.sourceHashes).length} text files`);
