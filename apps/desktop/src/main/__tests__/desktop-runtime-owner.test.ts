import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDesktopRuntimeOwner } from '../desktop-runtime-owner.js';

test('keeps the production default on the embedded owner', () => {
  assert.equal(resolveDesktopRuntimeOwner(undefined), 'embedded');
  assert.equal(resolveDesktopRuntimeOwner(''), 'embedded');
  assert.equal(resolveDesktopRuntimeOwner('embedded'), 'embedded');
});

test('selects the Runtime Host only through the explicit opt-in', () => {
  assert.equal(resolveDesktopRuntimeOwner('runtime-host'), 'runtime-host');
});

test('rejects unknown owner values instead of falling back', () => {
  assert.throws(
    () => resolveDesktopRuntimeOwner('host'),
    /MAKA_DESKTOP_RUNTIME_OWNER must be "embedded" or "runtime-host"/,
  );
});
