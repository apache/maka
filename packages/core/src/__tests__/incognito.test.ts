import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateWorkspacePrivacyContext } from '../incognito.js';

describe('workspace privacy context', () => {
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
    for (const input of [null, 'incognito', []]) {
      assert.equal(validateWorkspacePrivacyContext(input).ok, false);
    }
    for (const input of [{}, { incognitoActive: 'true' }]) {
      assert.deepEqual(validateWorkspacePrivacyContext(input), {
        ok: false,
        reason: 'incognito_active_invalid',
        message: 'WorkspacePrivacyContext.incognitoActive must be a boolean',
      });
    }
  });
});
