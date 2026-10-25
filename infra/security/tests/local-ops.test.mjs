import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectFile } from '../check-git-safety.mjs';
import { runDrill } from '../local-backup-drill.mjs';

for (const path of ['.env', 'backend/.env.production', 'originals/photo.jpg', 'storage/private/photo.png', 'db-dumps/test.sql', 'db_dump.sql', 'key.pem', '.aws/config']) {
  test(`unsafe Git path rejected: ${path}`, () => assert.ok(inspectFile(path, Buffer.from('synthetic')).length));
}
test('migrations and empty distributable environment examples are accepted', () => {
  assert.deepEqual(inspectFile('backend/prisma/migrations/fixture/migration.sql', Buffer.from('CREATE TABLE fixture (id INT);')), []);
  assert.deepEqual(inspectFile('.env.example', Buffer.from('JWT_SECRET=\nAI_IMAGE_API_KEY=\n')), []);
});
test('example signing secrets are rejected without printing their values', () => {
  const value = 'synthetic-' + 'fixture-secret';
  const findings = inspectFile('.env.example', Buffer.from('JWT_SECRET=' + value));
  assert.equal(findings[0].rule, 'nonempty-secret-in-example');
  assert.equal(JSON.stringify(findings).includes(value), false);
});
test('embedded private keys are rejected regardless of extension', () => {
  const marker = '-----BEGIN ' + 'PRIVATE KEY-----';
  assert.equal(inspectFile('src/config.txt', Buffer.from(marker))[0].rule, 'private-key-content');
});
test('synthetic encrypted backup roundtrip and negative cases pass', () => {
  const result = runDrill();
  assert.equal(Object.values(result.checks).every(Boolean), true);
  assert.equal(result.realRpoMeasured, false);
  assert.equal(result.realRtoMeasured, false);
});
