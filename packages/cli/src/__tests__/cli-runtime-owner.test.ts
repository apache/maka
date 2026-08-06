import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CLI_RUNTIME_OWNER_ENV, resolveCliRuntimeOwner } from '../cli-runtime-owner.js';

describe('CLI Runtime owner', () => {
  test('keeps embedded as the default and enables Runtime Host explicitly', () => {
    assert.equal(resolveCliRuntimeOwner(undefined), 'embedded');
    assert.equal(resolveCliRuntimeOwner(''), 'embedded');
    assert.equal(resolveCliRuntimeOwner('embedded'), 'embedded');
    assert.equal(resolveCliRuntimeOwner('runtime-host'), 'runtime-host');
  });

  test('rejects an unknown owner instead of silently opening embedded state', () => {
    assert.throws(
      () => resolveCliRuntimeOwner('host'),
      new Error(`${CLI_RUNTIME_OWNER_ENV} must be "embedded" or "runtime-host"`),
    );
  });
});
