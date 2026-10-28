import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameSchema } from '../schema-equivalence.mjs';
test('generated schema formatting and comments are equivalent', () => {
  assert.ok(sameSchema('model A {\n id Int @id // note\n}', 'model A{\n\n id  Int  @id\n}'));
});
test('field type and database mapping changes require regeneration', () => {
  assert.equal(sameSchema('model A { id Int @id }', 'model A { id BigInt @id }'), false);
  assert.equal(sameSchema('@@map("a")', '@@map("b")'), false);
});
test('quoted spaces and slash characters are preserved', () => {
  assert.equal(sameSchema('@default("a b")', '@default("ab")'), false);
  assert.equal(sameSchema('@default("a//b")', '@default("a//c")'), false);
});
test('identifier boundaries remain significant', () => {
  assert.equal(sameSchema('model A', 'modelA'), false);
});
