import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Fixture rehearsal only. No connection strings, actual DB, photos or cloud APIs.
export function runDrill() {
  const parent = resolve(tmpdir());
  const scratch = mkdtempSync(resolve(parent, 'kkagung-backup-fixture-'));
  if (!resolve(scratch).startsWith(parent + sep) || !scratch.includes('kkagung-backup-fixture-')) throw new Error('Unsafe fixture path');
  const key = randomBytes(32); // Kept in memory only; never logged or written.
  const started = performance.now();
  try {
    const fixture = {
      users: [{ id: '1', role: 'ADMIN', status: 'ACTIVE' }, { id: '2', role: 'USER', status: 'SUSPENDED' }],
      revokedTokens: [{ tokenHash: createHash('sha256').update('synthetic-token-fixture').digest('hex'), userId: '2' }],
      objects: [{ objectKey: 'fixture/private/object-1', payload: 'SYNTHETIC_NON_IMAGE_BYTES' }],
      audit: [{ action: 'FIXTURE_SETTING', before: 10, after: 11 }],
    };
    const plain = Buffer.from(JSON.stringify(fixture));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const archive = resolve(scratch, 'fixture.enc');
    writeFileSync(archive, Buffer.concat([iv, tag, encrypted]), { mode: 0o600 });
    const decrypt = bytes => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    };
    const bytes = readFileSync(archive);
    assert.equal(bytes.includes(Buffer.from('SYNTHETIC_NON_IMAGE_BYTES')), false);
    const restored = decrypt(bytes);
    assert.deepEqual(JSON.parse(restored.toString()), fixture);
    assert.equal(createHash('sha256').update(restored).digest('hex'), createHash('sha256').update(plain).digest('hex'));
    const damaged = Buffer.from(bytes); damaged[damaged.length - 1] ^= 1;
    assert.throws(() => decrypt(damaged));
    assert.throws(() => decrypt(bytes.subarray(0, bytes.length - 5)));
    const invalidTag = Buffer.from(bytes); invalidTag[12] ^= 1;
    assert.throws(() => decrypt(invalidTag));
    return { mode: 'synthetic local file encryption roundtrip only; NOT MySQL/object storage restore', algorithm: 'AES-256-GCM',
      checks: { encryptedContent: true, exactRoundtrip: true, sha256Match: true, roleAndStatusPreserved: true, revocationRecordPreserved: true, tamperingRejected: true, truncationRejected: true, invalidTagRejected: true },
      fixtureCounts: { users: 2, revokedTokens: 1, objects: 1, audit: 1 }, durationMs: Math.round(performance.now() - started),
      realRpoMeasured: false, realRtoMeasured: false, realAccessControlTested: false };
  } finally {
    key.fill(0);
    // The absolute scratch child was checked above; only our newly created folder is removed.
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runDrill();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    if (process.argv.includes('--evidence')) writeFileSync(resolve(root, 'infra/security/evidence/local-backup-drill.json'), JSON.stringify({ recordedAt: new Date().toISOString(), ...result }, null, 2) + '\n');
    console.log('Local synthetic backup drill: 8 checks passed. Real DB/storage restore remains untested.');
  } catch { console.error('Local backup fixture drill failed; no raw fixture/key/error is logged.'); process.exitCode = 1; }
}
