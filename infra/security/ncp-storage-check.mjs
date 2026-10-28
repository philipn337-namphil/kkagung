import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

export function validateStorageEnvironment(env, execute = false) {
  const endpoint = new URL(env.OBJECT_STORAGE_ENDPOINT ?? 'file:///missing');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('HTTPS endpoint without embedded credentials is required');
  if (env.NODE_ENV === 'production' || env.APP_ENV === 'production' || env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('Production or disabled TLS verification is not allowed');
  const buckets = [env.OBJECT_STORAGE_BUCKET_PRIVATE, env.OBJECT_STORAGE_BUCKET_PUBLIC];
  if (buckets.some(value => !/^kkagung-(test|staging|security)-[a-z0-9-]+$/.test(value ?? '')) || buckets[0] === buckets[1])
    throw new Error('Distinct pre-existing test buckets are required');
  if (execute && (env.SECURITY_STORAGE_TEST_RESOURCES !== 'true' || !env.OBJECT_STORAGE_ACCESS_KEY || !env.OBJECT_STORAGE_SECRET_KEY))
    throw new Error('Explicit test-resource flag and test credentials are required');
  return { endpoint: endpoint.origin, privateBucket: buckets[0], publicBucket: buckets[1] };
}

async function run(env) {
  const plan = validateStorageEnvironment(env, true);
  const require = createRequire(new URL('../../backend/package.json', import.meta.url));
  const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const runId = randomUUID(), prefix = `originals/security-drill/${runId}/`;
  const privateKey = prefix + 'original.txt', publicKey = `profiles/blur/security-drill/${runId}/public.txt`;
  const body = Buffer.from('kkagung synthetic storage security fixture');
  const client = new S3Client({ endpoint: plan.endpoint, region: env.OBJECT_STORAGE_REGION || 'kr-standard', forcePathStyle: true,
    credentials: { accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY },
    requestHandler: { connectionTimeout: 5000, requestTimeout: 10000 }, maxAttempts: 1 });
  const result = { recordedAt: new Date().toISOString(), mode: 'pre-existing test buckets; synthetic text only',
    checks: {}, cleanup: {}, productionRestoreVerified: false };
  const url = (bucket, key) => `${plan.endpoint}/${bucket}/${key}`;
  const status = async value => {
    const response = await fetch(value, { signal: AbortSignal.timeout(12000), redirect: 'error' });
    await response.arrayBuffer(); return response.status;
  };
  try {
    await client.send(new PutObjectCommand({ Bucket: plan.privateBucket, Key: privateKey, Body: body, ContentType: 'text/plain' }));
    await client.send(new PutObjectCommand({ Bucket: plan.publicBucket, Key: publicKey, Body: body, ContentType: 'text/plain' }));
    result.checks.privateAnonymousDenied = [401, 403].includes(await status(url(plan.privateBucket, privateKey)));
    result.checks.privateAnonymousListDenied = [401, 403].includes(await status(`${plan.endpoint}/${plan.privateBucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`));
    result.checks.publicAnonymousReadable = await status(url(plan.publicBucket, publicKey)) === 200;
    const signed = await getSignedUrl(client, new GetObjectCommand({ Bucket: plan.privateBucket, Key: privateKey }), { expiresIn: 60 });
    result.checks.signedReadable = await status(signed) === 200;
    const tampered = new URL(signed), signature = tampered.searchParams.get('X-Amz-Signature');
    tampered.searchParams.set('X-Amz-Signature', signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0'));
    result.checks.tamperedDenied = [401, 403].includes(await status(tampered));
    const short = await getSignedUrl(client, new GetObjectCommand({ Bucket: plan.privateBucket, Key: privateKey }), { expiresIn: 2 });
    await new Promise(done => setTimeout(done, 4000));
    result.checks.expiredDenied = [401, 403].includes(await status(short));
  } catch (error) { result.errorKind = error.name; }
  finally {
    for (const [kind, Bucket, Key] of [['private', plan.privateBucket, privateKey], ['public', plan.publicBucket, publicKey]]) {
      // Only these two freshly generated keys are ever deleted. No bucket/policy/list-wide deletion.
      try { await client.send(new DeleteObjectCommand({ Bucket, Key })); result.cleanup[kind] = true; }
      catch { result.cleanup[kind] = false; }
    }
    client.destroy();
  }
  result.success = Object.keys(result.checks).length === 6 && Object.values(result.checks).every(Boolean)
    && Object.values(result.cleanup).every(Boolean) && !result.errorKind;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? '--plan';
  try {
    if (mode === '--plan') console.log(JSON.stringify({ ...validateStorageEnvironment(process.env), mode: 'plan only; no network calls' }, null, 2));
    else if (mode === '--run') {
      const result = await run(process.env);
      writeFileSync(new URL('evidence/ncp-storage-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
      console.log(JSON.stringify(result, null, 2)); process.exitCode = result.success ? 0 : 1;
    } else throw new Error('Use --plan or --run');
  } catch { console.error('Storage preflight failed; check test-only environment configuration. No credentials printed.'); process.exitCode = 2; }
}
