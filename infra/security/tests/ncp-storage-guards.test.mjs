import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStorageEnvironment } from '../ncp-storage-check.mjs';
const fixture = () => ({ OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET_PRIVATE: 'kkagung-test-private', OBJECT_STORAGE_BUCKET_PUBLIC: 'kkagung-test-public' });
test('plan accepts only distinct fixture buckets and requires no credentials', () => {
  assert.equal(validateStorageEnvironment(fixture()).privateBucket, 'kkagung-test-private');
});
test('rejects production flags and disabled TLS', () => {
  for (const extra of [{ NODE_ENV: 'production' }, { APP_ENV: 'production' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }])
    assert.throws(() => validateStorageEnvironment({ ...fixture(), ...extra }));
});
test('rejects non-TLS or embedded credentials before any network operation', () => {
  for (const value of ['http://example.invalid', 'https://fixture:secret@example.invalid', 'https://example.invalid?key=fixture'])
    assert.throws(() => validateStorageEnvironment({ ...fixture(), OBJECT_STORAGE_ENDPOINT: value }));
});
test('rejects production-style names or the same public and private bucket', () => {
  assert.throws(() => validateStorageEnvironment({ ...fixture(), OBJECT_STORAGE_BUCKET_PRIVATE: 'kkagung-images-private' }));
  assert.throws(() => validateStorageEnvironment({ ...fixture(), OBJECT_STORAGE_BUCKET_PRIVATE: 'kkagung-test-public' }));
});
test('execution requires explicit test-resource flag plus credentials', () => {
  assert.throws(() => validateStorageEnvironment(fixture(), true));
  assert.throws(() => validateStorageEnvironment({ ...fixture(), SECURITY_STORAGE_TEST_RESOURCES: 'true' }, true));
});
