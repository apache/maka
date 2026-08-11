import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultWorkspacePrivacyContext,
  isWorkspacePrivacyContext,
  validateWorkspacePrivacyContext,
} from '../incognito.js';

describe('workspace privacy context', () => {
  it('defaults explicitly to non-incognito', () => {
    assert.deepEqual(defaultWorkspacePrivacyContext(), { incognitoActive: false });
  });

  it('accepts booleans and strips renderer-supplied authority fields', () => {
    assert.deepEqual(
      validateWorkspacePrivacyContext({
        incognitoActive: true,
        durableWriteAllowed: true,
      }),
      { ok: true, value: { incognitoActive: true } },
    );
  });

  it('fails closed for non-objects and missing or non-boolean state', () => {
    for (const input of [null, undefined, 'incognito', 42, true, []]) {
      assert.equal(validateWorkspacePrivacyContext(input).ok, false);
    }
    for (const input of [{}, { incognitoActive: 'true' }, { incognitoActive: 1 }]) {
      assert.deepEqual(validateWorkspacePrivacyContext(input), {
        ok: false,
        reason: 'incognito_active_invalid',
        message: 'WorkspacePrivacyContext.incognitoActive must be a boolean',
      });
    }
  });

  it('guards the documented field without requiring an exact object shape', () => {
    assert.equal(isWorkspacePrivacyContext({ incognitoActive: false }), true);
    assert.equal(isWorkspacePrivacyContext({ incognitoActive: true, extra: 'ignored' }), true);
    for (const input of [null, undefined, [], {}, { incognitoActive: 'true' }]) {
      assert.equal(isWorkspacePrivacyContext(input), false);
    }
  });
});
