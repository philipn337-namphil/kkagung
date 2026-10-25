import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function makePlan(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('Invalid isolated run identifier');
  return { name: `kkagung-security-${id}`, label: `kkagung.security.drill=${id}`,
    database: `kkagung_security_${id}`, restored: `kkagung_restore_${id}`,
    image: 'mysql:8.4', publish: '127.0.0.1::3306' };
}
export function databaseUrl(plan, port, password) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid mapped port');
  return `mysql://kkagung_drill:${encodeURIComponent(password)}@127.0.0.1:${port}/${plan.database}`;
}
export function ownsContainer(plan, label) {
  return label.trim() === plan.label.split('=')[1];
}

// The runner never accepts a caller-supplied database URL or container name.
// All destructive test operations are confined to the container created here.
export function runDrill() {
  const plan = makePlan(randomBytes(8).toString('hex'));
  const evidence = { recordedAt: new Date().toISOString(), mode: 'isolated synthetic MySQL only',
    status: 'blocked', steps: {}, backupRestore: 'not-run', cloudStorageVerified: false,
    productionRpoMeasured: false, productionRtoMeasured: false };
  const execute = (command, args, env = process.env, input) => spawnSync(command, args,
    { cwd: root, env, input, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  const docker = (args, env, input) => execute('docker', args, env, input);
  const check = (result, stage) => {
    evidence.steps[stage] = result.status === 0 && !result.error;
    if (!evidence.steps[stage]) throw new Error(stage); // Never publish child output or connection strings.
    return result.stdout;
  };
  const prerequisite = docker(['info', '--format', '{{.ServerVersion}}']);
  if (prerequisite.error || prerequisite.status !== 0) {
    evidence.blocker = 'Docker engine unavailable; no DB changes attempted';
    return evidence;
  }
  const rootPassword = randomBytes(32).toString('hex'), appPassword = randomBytes(32).toString('hex');
  const env = { ...process.env, MYSQL_ROOT_PASSWORD: rootPassword, MYSQL_PASSWORD: appPassword,
    MYSQL_DATABASE: plan.database, MYSQL_USER: 'kkagung_drill', MYSQL_PWD: rootPassword };
  const sql = (query, database) => docker(['exec', '-e', 'MYSQL_PWD', plan.name, 'mysql', '-uroot',
    '--batch', '--skip-column-names', ...(database ? [database] : []), '-e', query], env);
  let created = false;
  try {
    check(docker(['run', '-d', '--rm', '--name', plan.name, '--label', plan.label,
      '-p', plan.publish, '-e', 'MYSQL_ROOT_PASSWORD', '-e', 'MYSQL_PASSWORD',
      '-e', 'MYSQL_DATABASE', '-e', 'MYSQL_USER', plan.image], env), 'container-created');
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (sql('SELECT 1').status === 0) { ready = true; break; }
      // Short blocking waits only inside this standalone CLI, bounded to one minute.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    if (!ready) throw new Error('database-ready');
    evidence.steps['database-ready'] = true;
    const mapping = check(docker(['port', plan.name, '3306/tcp']), 'loopback-port');
    if (!/^127\.0\.0\.1:\d+\s*$/.test(mapping)) throw new Error('unexpected-port-binding');
    const port = Number(mapping.trim().split(':')[1]);
    const testEnv = { ...process.env, DATABASE_URL: databaseUrl(plan, port, appPassword),
      NODE_ENV: 'test', APP_ENV: 'development', JWT_SECRET: randomBytes(48).toString('hex'),
      ENABLE_TEST_ACCOUNTS: 'true', ADMIN_ALLOWED_IP_CIDRS: '127.0.0.1' };
    const node = (args) => execute(process.execPath, args, testEnv);
    check(node(['backend/node_modules/prisma/build/index.js', 'generate', '--schema', 'backend/prisma/schema.prisma']), 'prisma-generate');
    check(node(['backend/node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'backend/prisma/schema.prisma']), 'migration');
    check(node(['--import', './backend/node_modules/tsx/dist/loader.mjs', 'backend/prisma/seed.ts']), 'synthetic-seed');
    // Test from backend so its Vitest configuration and setup are used.
    const tests = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json'],
      { cwd: resolve(root, 'backend'), env: testEnv, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    evidence.steps['backend-tests'] = tests.status === 0 && !tests.error;
    try {
      const result = JSON.parse(tests.stdout);
      evidence.tests = { passed: result.numPassedTests, failed: result.numFailedTests,
        pending: result.numPendingTests, cases: result.testResults.flatMap(file =>
          file.assertionResults.map(test => ({ name: test.fullName, status: test.status }))) };
    } catch { throw new Error('backend-test-json-report'); }
    // Backup is kept in memory, never committed or written to an unencrypted file.
    const dump = check(docker(['exec', '-e', 'MYSQL_PWD', plan.name, 'mysqldump', '-uroot',
      '--single-transaction', '--no-tablespaces', '--set-gtid-purged=OFF', plan.database], env), 'backup');
    check(sql(`CREATE DATABASE ${plan.restored}`), 'restore-database');
    check(docker(['exec', '-i', '-e', 'MYSQL_PWD', plan.name, 'mysql', '-uroot', plan.restored], env, dump), 'restore-import');
    const tables = check(sql('SHOW TABLES', plan.database), 'table-list').trim().split(/\r?\n/).filter(Boolean);
    if (!tables.length || tables.some(name => !/^[A-Za-z0-9_]+$/.test(name))) throw new Error('invalid-table-list');
    const count = database => tables.map(table => check(sql(`SELECT COUNT(*) FROM \`${table}\``, database), 'row-counts').trim());
    const checksums = database => tables.map(table => {
      const value = check(sql(`CHECKSUM TABLE \`${table}\` EXTENDED`, database), 'table-checksums').trim().split('\t')[1];
      if (!value || value === 'NULL') throw new Error('unsupported-table-checksum');
      return value;
    });
    if (JSON.stringify(count(plan.database)) !== JSON.stringify(count(plan.restored)) ||
      JSON.stringify(checksums(plan.database)) !== JSON.stringify(checksums(plan.restored))) throw new Error('restore-mismatch');
    evidence.backupRestore = 'row-counts-and-table-checksums-match';
    evidence.restoredTableCount = tables.length;
    evidence.status = evidence.steps['backend-tests'] ? 'passed-local-db-only' : 'failed-tests';
  } catch (error) { evidence.status = 'failed'; evidence.failedStage = error.message; }
  finally {
    if (created) {
      const owner = docker(['inspect', '--format', '{{index .Config.Labels "kkagung.security.drill"}}', plan.name]);
      if (owner.status === 0 && ownsContainer(plan, owner.stdout))
        evidence.cleanup = docker(['rm', '-f', '-v', plan.name]).status === 0;
      else evidence.cleanup = false;
      if (!evidence.cleanup) { evidence.status = 'failed'; evidence.failedStage = 'cleanup-ownership-or-removal'; }
    }
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--plan', '--run'].includes(args[0])) {
    console.error('Usage: node infra/security/isolated-db-drill.mjs --plan|--run'); process.exitCode = 2;
  } else if (args[0] === '--plan') {
    console.log(JSON.stringify({ ...makePlan('0123456789abcdef'), action: 'preview only; no Docker or DB access' }, null, 2));
  } else {
    const result = runDrill();
    writeFileSync(resolve(root, 'infra/security/evidence/isolated-db-drill.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'passed-local-db-only' ? 0 : 1;
  }
}
