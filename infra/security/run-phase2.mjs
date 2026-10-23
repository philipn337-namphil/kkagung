import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = (args, cwd = root) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 120000 });
const baseline = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const build = run(['node_modules/typescript/bin/tsc'], join(root, 'backend'));
const temp = mkdtempSync(join(tmpdir(), 'kkagung-security-'));
const rawPath = join(temp, 'vitest.json');
const tests = run(['backend/node_modules/vitest/vitest.mjs', 'run', '--config', 'infra/security/vitest.config.mjs', '--reporter=json', `--outputFile=${rawPath}`]);
let raw;
try { raw = JSON.parse(readFileSync(rawPath, 'utf8')); }
catch {
  console.error('Test runner did not produce results. Check local dependency installation and loopback permissions.');
  process.exit(2);
}
// Publish only test names/status and build outcome. Never publish JWTs, passwords or raw error objects.
const result = {
  baselineCommit: baseline.stdout.trim(),
  recordedAt: new Date().toISOString(),
  node: process.version,
  mode: 'real HTTP routes, mock Prisma; no live DB/storage',
  build: { exitCode: build.status, success: build.status === 0 },
  tests: {
    exitCode: tests.status,
    passed: raw.numPassedTests, failed: raw.numFailedTests,
    pending: raw.numPendingTests, total: raw.numTotalTests,
    cases: raw.testResults.flatMap(file => file.assertionResults.map(test => ({ name: test.fullName, status: test.status }))),
  },
};
const destination = join(root, 'infra/security/evidence');
mkdirSync(destination, { recursive: true });
writeFileSync(join(destination, 'phase2-results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`Build: ${result.build.success ? 'PASS' : 'FAIL'}. Tests: ${result.tests.passed} passed, ${result.tests.failed} failed, ${result.tests.pending} pending.`);
console.log('Sanitized evidence: infra/security/evidence/phase2-results.json');
process.exit(build.status === 0 && tests.status === 0 ? 0 : 1);
