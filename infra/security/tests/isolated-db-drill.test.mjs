import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, databaseUrl, ownsContainer } from '../isolated-db-drill.mjs';

test('rejects caller-controlled container or SQL identifiers', () => {
  for (const value of ['production', '../db', 'a'.repeat(16) + ';DROP DATABASE app', '', undefined])
    assert.throws(() => makePlan(value));
});
test('connection always targets isolated loopback DB, independent of ambient URL', () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'mysql://production.invalid/shared';
  try {
    const plan = makePlan('0123456789abcdef');
    const url = new URL(databaseUrl(plan, 49321, 'a@:/?#%'));
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, '49321');
    assert.equal(url.pathname, '/kkagung_security_0123456789abcdef');
    assert.equal(decodeURIComponent(url.password), 'a@:/?#%');
    assert.equal(plan.publish, '127.0.0.1::3306');
  } finally { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; }
});
test('refuses malformed or out-of-range ports', () => {
  for (const port of [0, -1, 65536, NaN, '3306', 1.5])
    assert.throws(() => databaseUrl(makePlan('0123456789abcdef'), port, 'synthetic'));
});
test('cleanup requires exact run ownership label', () => {
  const plan = makePlan('0123456789abcdef');
  assert.equal(ownsContainer(plan, '0123456789abcdef\n'), true);
  for (const label of ['', 'production', '0123456789abcdef-other']) assert.equal(ownsContainer(plan, label), false);
});
