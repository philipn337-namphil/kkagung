import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { makePlan, databaseUrl } from './isolated-db-drill.mjs';
import { sameSchema } from './schema-equivalence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [mysqlHomeArg, backendArg] = process.argv.slice(2);
if (!mysqlHomeArg || !backendArg) {
  console.error('Usage: node infra/security/portable-db-drill.mjs <official-mysql-directory> <backend-directory>');
  process.exit(2);
}
const mysqlHome = resolve(mysqlHomeArg), backend = resolve(backendArg);
if (!/^[\x20-\x7e]+$/.test(mysqlHome)) {
  console.error('Use an ASCII MySQL tools path, for example under the Windows TEMP directory'); process.exit(2);
}
if (!existsSync(resolve(mysqlHome, 'bin/mysqld.exe')) || !existsSync(resolve(backend, 'prisma/schema.prisma'))) {
  console.error('MySQL executable or backend schema missing'); process.exit(2);
}
const id = randomBytes(8).toString('hex');
const plan = makePlan(id);
const runDir = resolve(mysqlHome, '..', `drill-${id}`), dataDir = resolve(runDir, 'data');
mkdirSync(runDir, { recursive: false });
const password = randomBytes(32).toString('hex'), appPassword = randomBytes(32).toString('hex');
const { database, restored } = plan;
const init = resolve(runDir, 'initialize.sql');
const evidence = { recordedAt: new Date().toISOString(), mode: 'real isolated portable MySQL; synthetic data',
  status: 'failed', steps: {}, cloudStorageVerified: false, productionRpoMeasured: false, productionRtoMeasured: false };
const exec = (command, args, env = process.env, input, cwd = root, timeout = 180000) => spawnSync(command, args,
  { cwd, env, input, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
const check = (result, stage) => {
  const firstCheck = evidence.steps[stage] === undefined;
  evidence.steps[stage] = result.status === 0 && !result.error;
  if (firstCheck) console.log(`${stage}: ${evidence.steps[stage] ? 'PASS' : 'FAIL'}`);
  if (!evidence.steps[stage]) {
    writeFileSync(resolve(runDir, `${stage}.log`), String(result.stdout ?? '') + String(result.stderr ?? '') + (result.error?.code ?? ''));
    throw new Error(stage);
  }
  return result.stdout;
};
const port = await new Promise((done, reject) => {
  const probe = createServer(); probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => done(value)); });
});
const env = { ...process.env, MYSQL_PWD: password };
const mysql = (args, input) => exec(resolve(mysqlHome, 'bin/mysql.exe'),
  ['--no-defaults', '--protocol=TCP', '--host=127.0.0.1', `--port=${port}`, '--user=root', '--batch', '--skip-column-names', ...args], env, input);
const sql = (query, db) => mysql([...(db ? [db] : []), '-e', query]);
let server, exitPromise;
try {
  check(exec(resolve(mysqlHome, 'bin/mysqld.exe'), ['--no-defaults', '--initialize-insecure',
    `--basedir=${mysqlHome}`, `--datadir=${dataDir}`]), 'initialize-new-data-directory');
  writeFileSync(init, `ALTER USER 'root'@'localhost' IDENTIFIED BY '${password}';\nCREATE DATABASE ${database};\nCREATE USER 'kkagung_drill'@'127.0.0.1' IDENTIFIED BY '${appPassword}';\nGRANT ALL ON ${database}.* TO 'kkagung_drill'@'127.0.0.1';\n`, { mode: 0o600 });
  const startupLog = openSync(resolve(runDir, 'startup.log'), 'w');
  server = spawn(resolve(mysqlHome, 'bin/mysqld.exe'), ['--no-defaults', `--basedir=${mysqlHome}`,
    `--datadir=${dataDir}`, '--bind-address=127.0.0.1', `--port=${port}`, '--mysqlx=OFF',
    '--skip-log-bin', `--init-file=${init}`, `--log-error=${resolve(runDir, 'mysql-error.log')}`],
    { windowsHide: true, stdio: ['ignore', startupLog, startupLog] });
  closeSync(startupLog);
  let exited = false;
  exitPromise = new Promise(done => { server.once('error', () => { exited = true; done(); }); server.once('exit', code => { exited = true; evidence.serverExitCode = code; done(); }); });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !exited; attempt++) {
    if (sql('SELECT 1').status === 0) { ready = true; break; }
    await new Promise(done => setTimeout(done, 1000));
  }
  if (!ready) throw new Error('database-ready');
  evidence.steps['database-ready'] = true;
  unlinkSync(init);
  evidence.mysqlVersion = check(sql('SELECT VERSION()'), 'mysql-version').trim();
  evidence.backendCommit = check(exec('git', ['rev-parse', 'HEAD'], process.env, undefined, backend), 'source-commit').trim();
  const testEnv = { ...process.env, MYSQL_PWD: undefined,
    DATABASE_URL: databaseUrl(plan, port, appPassword),
    NODE_ENV: 'test', APP_ENV: 'development', JWT_SECRET: randomBytes(48).toString('hex'),
    ENABLE_TEST_ACCOUNTS: 'true', ADMIN_ALLOWED_IP_CIDRS: '127.0.0.1', SECURITY_DB_RUN_ID: id,
    OBJECT_STORAGE_BUCKET_PUBLIC: 'kkagung-drill-public' };
  const node = (args, timeout) => exec(process.execPath, args, testEnv, undefined, backend, timeout);
  const generatedSchema = resolve(backend, 'node_modules/.prisma/client/schema.prisma');
  if (existsSync(generatedSchema) && sameSchema(readFileSync(generatedSchema, 'utf8'), readFileSync(resolve(backend, 'prisma/schema.prisma'), 'utf8'))) {
    evidence.steps['prisma-generate'] = true; evidence.prismaClient = 'reused-token-equivalent-generated-schema';
  } else check(node(['node_modules/prisma/build/index.js', 'generate']), 'prisma-generate');
  check(node(['node_modules/prisma/build/index.js', 'migrate', 'deploy']), 'migration');
  check(node(['--import', './node_modules/tsx/dist/loader.mjs', 'prisma/seed.ts']), 'synthetic-seed');
  check(node(['node_modules/typescript/bin/tsc']), 'build');
  if (process.env.SECURITY_FOCUSED_AUDIT === '1') {
    evidence.steps['backend-tests'] = null; evidence.testReport = { notRun: true, reason: 'explicit focused security audit; full suite evidence retained separately' };
  } else {
  const selection = process.env.SECURITY_TARGETED_BACKEND === '1' ? ['tests/dev.test.ts', 'tests/trustProxy.test.ts', 'tests/images.test.ts'] : [];
  evidence.backendSelection = selection.length ? selection : 'all';
  const tests = node(['node_modules/vitest/vitest.mjs', 'run', ...selection, '--reporter=json', '--hookTimeout=60000',
    `--testTimeout=${selection.length || process.env.SECURITY_FRONTEND_AUDIT === '1' ? 60000 : 30000}`, '--maxWorkers=1'], 600000);
  writeFileSync(resolve(runDir, 'tests-private.json'), tests.stdout ?? '');
  writeFileSync(resolve(runDir, 'tests-private.stderr.log'), tests.stderr ?? '');
  evidence.steps['backend-tests'] = tests.status === 0 && !tests.error;
  let parsed;
  try { parsed = JSON.parse(tests.stdout); } catch {
    evidence.steps['backend-tests'] = false;
    evidence.testReport = { validJson: false, timedOut: tests.error?.code === 'ETIMEDOUT', exitCode: tests.status };
  }
  if (parsed) evidence.tests = { passed: parsed.numPassedTests, failed: parsed.numFailedTests, pending: parsed.numPendingTests,
    cases: parsed.testResults.flatMap(file => file.assertionResults.map(item => ({ name: item.fullName, status: item.status }))) };
  }
  const auditPath = resolve(root, 'infra/security/evidence/live-db-audit.json');
  if (process.env.SECURITY_MATRIX_ONLY === '1' || process.env.SECURITY_FRONTEND_AUDIT === '1') evidence.steps['live-db-audit'] = null;
  else {
    const audit = node(['--import', './node_modules/tsx/dist/loader.mjs', resolve(root, 'infra/security/live-db-audit.mjs'), backend, auditPath]);
    evidence.steps['live-db-audit'] = audit.status === 0 && !audit.error;
  }
  if (process.env.SECURITY_IMAGE_STATE_AUDIT === '1') {
    const imageAudit = node(['--import', './node_modules/tsx/dist/loader.mjs', resolve(root, 'infra/security/live-image-state-audit.mjs'), backend,
      resolve(root, 'infra/security/evidence/live-image-state-audit.json')]);
    evidence.steps['image-state-audit'] = imageAudit.status === 0 && !imageAudit.error;
    writeFileSync(resolve(runDir, 'image-audit-private.stderr.log'), imageAudit.stderr ?? '');
  }
    if (process.env.SECURITY_AUTH_MATRIX === '1') {
      const matrix = node(['--import', './node_modules/tsx/dist/loader.mjs', resolve(root, 'infra/security/live-authorization-matrix.mjs'), backend,
        resolve(root, 'infra/security/evidence/authorization-matrix.json')], 300000);
      evidence.steps['authorization-matrix'] = matrix.status === 0 && !matrix.error;
      console.log(`authorization-matrix: ${evidence.steps['authorization-matrix'] ? 'PASS' : 'FAIL'}`);
      writeFileSync(resolve(runDir, 'authorization-matrix-private.stderr.log'), matrix.stderr ?? '');
    }
    if (process.env.SECURITY_FRONTEND_AUDIT === '1') {
      check(node(['--import', './node_modules/tsx/dist/loader.mjs', 'prisma/seed.ts']), 'frontend-synthetic-seed');
      const frontend = node(['--import', './node_modules/tsx/dist/loader.mjs', resolve(root, 'infra/security/live-frontend-audit.mjs'), backend,
        resolve(root, 'infra/security/evidence/live-frontend-audit.json')], 750000);
      evidence.steps['frontend-audit'] = frontend.status === 0 && !frontend.error;
      console.log(`frontend-audit: ${evidence.steps['frontend-audit'] ? 'PASS' : 'FAIL'}`);
      writeFileSync(resolve(runDir, 'frontend-audit-private.stderr.log'), frontend.stderr ?? '');
    }
    const started = performance.now();
  const dump = check(exec(resolve(mysqlHome, 'bin/mysqldump.exe'), ['--no-defaults', '--protocol=TCP',
    '--host=127.0.0.1', `--port=${port}`, '--user=root', '--single-transaction', '--no-tablespaces',
    '--set-gtid-purged=OFF', database], env), 'backup');
  check(sql(`CREATE DATABASE ${restored}`), 'restore-database');
  check(mysql([restored], dump), 'restore-import');
  const tables = check(sql('SHOW TABLES', database), 'table-list').trim().split(/\r?\n/).filter(Boolean);
  if (!tables.length || tables.some(table => !/^[A-Za-z0-9_]+$/.test(table))) throw new Error('table-identifiers');
  const rowCounts = db => check(sql(tables.map(table => `SELECT '${table}', COUNT(*) FROM \`${table}\``).join(' UNION ALL '), db), 'row-counts').trim();
  const logicalHash = db => {
    const rows = check(exec(resolve(mysqlHome, 'bin/mysqldump.exe'), ['--no-defaults', '--protocol=TCP',
      '--host=127.0.0.1', `--port=${port}`, '--user=root', '--single-transaction', '--no-tablespaces',
      '--set-gtid-purged=OFF', '--no-create-info', '--skip-comments', '--skip-dump-date', '--skip-extended-insert',
      '--order-by-primary', '--compact', db], env), 'logical-data-dump');
    return createHash('sha256').update(rows).digest('hex');
  };
  const beforeCounts = rowCounts(database), afterCounts = rowCounts(restored);
  const beforeHash = logicalHash(database), afterHash = logicalHash(restored);
  if (beforeCounts !== afterCounts || beforeHash !== afterHash) throw new Error('restore-mismatch');
  evidence.restore = { success: true, tables: tables.length, rowCountsAndChecksumsMatch: true,
    checksumMethod: 'SHA-256 of primary-key-ordered logical row dump; no timestamps/comments/DDL',
    sourceSha256: beforeHash, restoredSha256: afterHash,
    localDumpRestoreVerifyMs: Math.round(performance.now() - started) };
  const auditsPassed = evidence.steps['live-db-audit'] !== false && evidence.steps['image-state-audit'] !== false && evidence.steps['frontend-audit'] !== false &&
    (process.env.SECURITY_MATRIX_ONLY === '1' ? evidence.steps['authorization-matrix'] === true : evidence.steps['authorization-matrix'] !== false);
  evidence.status = auditsPassed && evidence.steps['backend-tests'] === null ? 'focused-only'
    : auditsPassed && evidence.steps['backend-tests'] ? 'passed-local-db-only' : 'failed-tests';
} catch (error) { evidence.failedStage = error.message; }
finally {
  if (existsSync(init)) unlinkSync(init);
  if (server) {
    sql('SHUTDOWN');
    const stopped = await Promise.race([exitPromise.then(() => true), new Promise(done => setTimeout(() => done(false), 5000))]);
    if (!stopped) server.kill();
    evidence.serverStopped = stopped || await Promise.race([exitPromise.then(() => true), new Promise(done => setTimeout(() => done(false), 3000))]);
    if (!evidence.serverStopped) { evidence.status = 'failed'; evidence.failedStage = 'server-shutdown'; }
  }
  // Retain only the disposable local data directory for diagnosis; never copy it into Git.
  evidence.runtimeDirectory = runDir;
  writeFileSync(resolve(root, `infra/security/evidence/${process.env.SECURITY_FRONTEND_ONLY === '1' ? 'portable-db-frontend-only' : process.env.SECURITY_FRONTEND_AUDIT === '1' ? 'portable-db-frontend' : process.env.SECURITY_MATRIX_ONLY === '1' ? 'portable-db-matrix' : process.env.SECURITY_FOCUSED_AUDIT === '1' ? 'portable-db-focused' : process.env.SECURITY_TARGETED_BACKEND === '1' ? 'portable-db-recheck' : 'portable-db-drill'}.json`), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, steps: evidence.steps, failedStage: evidence.failedStage,
    tests: evidence.tests && { passed: evidence.tests.passed, failed: evidence.tests.failed, pending: evidence.tests.pending },
    restore: evidence.restore, serverStopped: evidence.serverStopped }, null, 2));
}
process.exitCode = evidence.status === 'passed-local-db-only' ? 0 : evidence.status === 'focused-only' ? 3 : 1;
