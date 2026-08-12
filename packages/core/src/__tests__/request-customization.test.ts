import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  normalizeRequestBodyOverlay,
  normalizeRequestHeaders,
  normalizeOptionalRequestBodyOverlay,
} from '../request-customization.js';

describe('request customization validation', () => {
  test('rejects protected and case-insensitively duplicated headers', () => {
    assert.throws(() => normalizeRequestHeaders({ Authorization: 'secret' }), /managed by Maka/);
    assert.throws(
      () => normalizeRequestHeaders({ 'X-Tenant': 'one', 'x-tenant': 'two' }),
      /Duplicate request header/,
    );
    assert.throws(() => normalizeRequestHeaders({ 'X-Title': 'Maka 中文' }), /Invalid value/);
    assert.throws(() => normalizeRequestHeaders({ 'X-Title': 'Maka\u0001' }), /Invalid value/);
    assert.doesNotThrow(() => normalizeRequestHeaders({ 'X-Title': 'Maka\tAgent' }));
    assert.throws(
      () =>
        normalizeRequestHeaders(
          Object.fromEntries(
            Array.from({ length: 8 }, (_, index) => [`X-${index}`, 'x'.repeat(8_192)]),
          ),
        ),
      /cannot exceed .* bytes/,
    );
  });

  test('accepts only safe top-level JSON objects', () => {
    assert.deepEqual(
      normalizeRequestBodyOverlay({ provider: { order: ['Anthropic'], allow_fallbacks: false } }),
      { provider: { order: ['Anthropic'], allow_fallbacks: false } },
    );
    assert.deepEqual(normalizeRequestBodyOverlay({ z: 1, nested: { z: 2, a: 1 }, a: 2 }), {
      a: 2,
      nested: { a: 1, z: 2 },
      z: 1,
    });
    assert.equal(normalizeOptionalRequestBodyOverlay({}), undefined);
    assert.throws(() => normalizeRequestBodyOverlay(['not', 'an', 'object']), /JSON object/);
    assert.throws(
      () => normalizeRequestBodyOverlay(JSON.parse('{"provider":{"__proto__":{}}}')),
      /not allowed/,
    );
  });
});
