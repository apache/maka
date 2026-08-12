import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  PKCE_VERIFIER_LENGTH_BYTES,
  base64urlEncode,
  buildClaudeAuthorizationUrl,
  constantTimeStringEqual,
  parsePastedAuthorization,
  pkceCodeChallenge,
  type ClaudeAuthorizationConfig,
  type Sha256Digest,
} from '../oauth-subscription.js';

const nodeSha256: Sha256Digest = {
  digest(input: string): Uint8Array {
    return new Uint8Array(createHash('sha256').update(input, 'utf8').digest());
  },
};

describe('OAuth subscription helpers', () => {
  it('matches base64url encoding for empty and reserved bytes', () => {
    assert.equal(base64urlEncode(new Uint8Array()), '');
    assert.equal(base64urlEncode(new Uint8Array([0xfb, 0xff, 0xbf])), '-_-_');
  });

  it('produces the RFC PKCE challenge with a safe verifier length', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    assert.equal(
      pkceCodeChallenge(verifier, nodeSha256),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    assert.equal(PKCE_VERIFIER_LENGTH_BYTES, 32);
  });

  it('builds a complete authorization URL and rejects missing inputs', () => {
    const config: ClaudeAuthorizationConfig = {
      clientId: 'test-client-id',
      authorizeEndpoint: 'https://claude.com/cai/oauth/authorize',
      redirectUri: 'https://platform.claude.com/oauth/code/callback',
      scope: 'user:sessions:claude_code user:mcp_servers user:file_upload',
    };
    const verifier = 'verifier_with_safe_chars_only_42';
    const state = 'state_value_safe';
    const url = new URL(buildClaudeAuthorizationUrl(config, verifier, state, nodeSha256));

    assert.equal(url.origin + url.pathname, config.authorizeEndpoint);
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      code: 'true',
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.redirectUri,
      scope: config.scope,
      code_challenge: pkceCodeChallenge(verifier, nodeSha256),
      code_challenge_method: 'S256',
      state,
    });

    const invalidCalls = [
      () => buildClaudeAuthorizationUrl({ ...config, clientId: '' }, verifier, state, nodeSha256),
      () => buildClaudeAuthorizationUrl(config, '', state, nodeSha256),
      () => buildClaudeAuthorizationUrl(config, verifier, '', nodeSha256),
    ];
    for (const call of invalidCalls) assert.throws(call);
  });

  it('parses only the strict code-state pasted shape', () => {
    assert.deepEqual(parsePastedAuthorization('abc_123-XYZ#state_value-42'), {
      code: 'abc_123-XYZ',
      state: 'state_value-42',
    });
    assert.deepEqual(parsePastedAuthorization('  \n  abc#xyz  \n'), {
      code: 'abc',
      state: 'xyz',
    });

    const invalid: unknown[] = [
      null,
      '   ',
      'abc',
      '#xyz',
      'abc#',
      'abc!#xyz',
      'abc#xy z',
      'abc#xy#z',
    ];
    for (const value of invalid) assert.equal(parsePastedAuthorization(value), null);
  });

  it('compares equal and unequal strings without widening the contract', () => {
    const cases = [
      ['abc', 'abc', true],
      ['', '', true],
      ['abc', 'abcd', false],
      ['abc', 'abd', false],
    ] as const;
    for (const [left, right, expected] of cases) {
      assert.equal(constantTimeStringEqual(left, right), expected);
    }
  });
});
