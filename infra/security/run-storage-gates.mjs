import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [mysqlHome, python, motoPackages, mode] = process.argv.slice(2);
if (mode && !['--focused', '--recheck', '--matrix'].includes(mode)) throw new Error('Unknown mode');
if (!mysqlHome || !python || !motoPackages) throw new Error('Usage: run-storage-gates.mjs <mysqlHome> <python> <motoPackages>');
const require = createRequire(resolve(root, 'backend/package.json'));
const { S3Client, CreateBucketCommand, PutBucketPolicyCommand } = require('@aws-sdk/client-s3');
const port = await new Promise((done, reject) => {
  const probe = createServer(); probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => done(value)); });
});
const endpoint = `http://127.0.0.1:${port}`;
const localTools = resolve(root, '../.local-tools'); mkdirSync(localTools, { recursive: true });
const temp = mkdtempSync(resolve(localTools, 'storage-gates-'));
const env = { ...process.env, PYTHONPATH: resolve(motoPackages), AWS_EC2_METADATA_DISABLED: 'true',
  OBJECT_STORAGE_ENDPOINT: endpoint, OBJECT_STORAGE_PUBLIC_ENDPOINT: '', OBJECT_STORAGE_REGION: 'us-east-1',
  OBJECT_STORAGE_ACCESS_KEY: randomBytes(16).toString('hex'), OBJECT_STORAGE_SECRET_KEY: randomBytes(32).toString('hex'),
  OBJECT_STORAGE_BUCKET_PUBLIC: 'kkagung-drill-public', OBJECT_STORAGE_BUCKET_PRIVATE: 'kkagung-drill-private',
  OBJECT_STORAGE_FORCE_PATH_STYLE: 'true', S3_IGNORE_SUBDOMAIN_BUCKETNAME: 'true', TRUST_PROXY: '', SECURITY_IMAGE_STATE_AUDIT: mode === '--matrix' ? '0' : '1',
  SECURITY_MATRIX_ONLY: mode === '--matrix' ? '1' : '0', SECURITY_AUTH_MATRIX: '1',
  SECURITY_FOCUSED_AUDIT: ['--focused', '--matrix'].includes(mode) ? '1' : '0', SECURITY_TARGETED_BACKEND: mode === '--recheck' ? '1' : '0' };
const moto = spawn(python, ['-m', 'moto.server', '-H', '127.0.0.1', '-p', String(port)],
  { env, windowsHide: true, stdio: 'ignore' });
let exited = false;
const motoExit = new Promise(done => { moto.once('error', () => { exited = true; done(); }); moto.once('exit', () => { exited = true; done(); }); });
const evidence = { recordedAt: new Date().toISOString(), storageMode: 'Moto S3 simulation on loopback; not NCP',
  signatureExpiryVerified: false, cloudBucketPolicyVerified: false, status: 'failed' };
let client;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60 && !exited; attempt++) {
    try { if ((await fetch(`${endpoint}/moto-api/`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 1000));
  }
  if (!ready) throw new Error('moto-startup');
  client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY } });
  for (const Bucket of [env.OBJECT_STORAGE_BUCKET_PUBLIC, env.OBJECT_STORAGE_BUCKET_PRIVATE]) await client.send(new CreateBucketCommand({ Bucket }));
  await client.send(new PutBucketPolicyCommand({ Bucket: env.OBJECT_STORAGE_BUCKET_PUBLIC, Policy: JSON.stringify({
    Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject',
      Resource: `arn:aws:s3:::${env.OBJECT_STORAGE_BUCKET_PUBLIC}/*` }],
  }) }));
  console.log('Loopback S3 simulation ready; public-read fixture bucket and private-default fixture bucket');
  const child = spawn(process.execPath, ['infra/security/portable-db-drill.mjs', resolve(mysqlHome), resolve(root, 'backend')],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', value => process.stdout.write(value));
  const errors = []; child.stderr.on('data', value => errors.push(value));
  const code = await new Promise(done => { child.once('error', () => done(2)); child.once('exit', done); });
  writeFileSync(resolve(temp, 'runner-private.stderr.log'), Buffer.concat(errors));
  evidence.status = code === 0 ? 'passed-local-simulation-only' : code === 3 ? 'focused-only' : 'failed';
} catch { evidence.status = 'failed'; }
finally {
  client?.destroy(); moto.kill();
  evidence.serverStopped = await Promise.race([motoExit.then(() => true), new Promise(done => setTimeout(() => done(false), 5000))]);
  if (!evidence.serverStopped) evidence.status = 'failed';
  writeFileSync(resolve(root, `infra/security/evidence/${mode === '--matrix' ? 'storage-matrix' : mode === '--focused' ? 'storage-focused' : mode === '--recheck' ? 'storage-recheck' : 'storage-gates'}.json`), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(`Storage simulation result: ${evidence.status}; server stopped: ${evidence.serverStopped}`);
process.exitCode = evidence.status === 'passed-local-simulation-only' ? 0 : evidence.status === 'focused-only' ? 3 : 1;
