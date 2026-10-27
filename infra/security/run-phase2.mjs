import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = (args, cwd = root) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 300000 });
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
  // HEAD is the baseline; hashes also identify uncommitted source actually tested.
  sourceHashes: Object.fromEntries([
    'backend/src/config.ts', 'backend/src/middleware/auth.ts', 'backend/src/routes/auth.ts',
    'backend/src/routes/me.ts', 'backend/src/app.ts', 'frontend/app.js', 'frontend/server.js',
    'backend/src/lib/tokenHash.ts', 'backend/src/middleware/rateLimit.ts', 'backend/prisma/schema.prisma',
    'backend/prisma/migrations/2026102501_security_token_and_rate_limits/migration.sql',
    'infra/security/tests/phase2.test.ts', 'infra/security/tests/frontend-config.test.ts', 'infra/security/tests/production-auth.test.ts',
    'infra/security/tests/upload-processing.test.ts', 'backend/src/lib/imageProcessing.ts',
    'backend/src/lib/objectStorage.ts', 'backend/src/routes/images.ts',
  ].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])),
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
