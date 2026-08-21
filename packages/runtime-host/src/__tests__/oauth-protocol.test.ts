import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  decodeOAuthLoginProjection,
  decodeOAuthPresentationRequest,
  decodeOAuthPresentationResult,
  type OAuthPresentationMethod,
} from '../protocol/index.js';

test('OAuth login protocol binds attempt identity and closes terminal projections', () => {
  assert.deepEqual(
    decodeClientFrame({
      requestId: 'request',
      operation: 'oauth.login.start',
      input: { attemptId: 'attempt', connectionId: 'connection' },
    }),
    {
      requestId: 'request',
      operation: 'oauth.login.start',
      input: { attemptId: 'attempt', connectionId: 'connection' },
    },
  );
  assert.deepEqual(
    decodeHostFrame({
      requestId: 'request',
      operation: 'oauth.login.start',
      ok: true,
      result: {
        attemptId: 'attempt',
        connectionId: 'connection',
        provider: 'openai-codex',
        phase: 'failed',
        failure: 'provider_rejected',
      },
    }),
    {
      requestId: 'request',
      operation: 'oauth.login.start',
      ok: true,
      result: {
        attemptId: 'attempt',
        connectionId: 'connection',
        provider: 'openai-codex',
        phase: 'failed',
        failure: 'provider_rejected',
      },
    },
  );
  assert.throws(
    () =>
      decodeHostFrame({
        requestId: 'request',
        operation: 'oauth.login.start',
        ok: true,
        result: {
          attemptId: 'attempt',
          connectionId: 'connection',
          provider: 'openai-codex',
          phase: 'authenticated',
          failure: 'internal_failure',
        },
      }),
    (error: unknown) => error instanceof RuntimeHostProtocolError,
  );
});

test('OAuth account usage is no longer an operation on the wire', () => {
  // Reporting subscription usage required the retired provider's own client
  // identity, so the operation went with it rather than staying as a call that
  // always answers "unavailable".
  assert.throws(
    () =>
      decodeHostFrame({
        requestId: 'request',
        operation: 'oauth.account.usage.fetch',
        ok: true,
        result: { kind: 'unavailable', reason: 'unsupported_provider' },
      }),
    RuntimeHostProtocolError,
  );
});

test('OAuth presentation keeps one closed request and result contract', () => {
  assert.deepEqual(
    decodeOAuthPresentationRequest('open_external', {
      url: 'https://auth.example/authorize',
      stateHint: 'ABCD-1234',
    }),
    {
      method: 'open_external',
      url: 'https://auth.example/authorize',
      stateHint: 'ABCD-1234',
    },
  );
  assert.deepEqual(decodeOAuthPresentationResult('open_external', { kind: 'presented' }), {
    kind: 'presented',
  });
  // A peer on an older epoch still offers the removed method. The cast models
  // that value arriving off the wire; the type no longer admits it, and the
  // decoder must refuse it rather than serve a method nothing implements.
  const retiredMethod = 'request_authorization_code' as unknown as OAuthPresentationMethod;
  assert.throws(
    () =>
      decodeOAuthPresentationRequest(retiredMethod, {
        url: 'https://auth.example/authorize',
        stateHint: 'ABCD-1234',
      }),
    (error: unknown) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () =>
      decodeOAuthPresentationResult(retiredMethod, {
        kind: 'authorization_code',
        authorizationCode: 'code#state',
      }),
    (error: unknown) => error instanceof RuntimeHostProtocolError,
  );
});

test('OAuth login projections refuse a retired provider on the wire', () => {
  // A Host on an older build can still emit this provider. Accepting it would
  // let a login the Client can no longer drive reach the projection.
  assert.throws(
    () =>
      decodeOAuthLoginProjection({
        attemptId: 'attempt',
        connectionId: 'connection',
        provider: 'claude-subscription',
        phase: 'awaiting_authorization',
      }),
    RuntimeHostProtocolError,
  );
  assert.deepEqual(
    decodeOAuthLoginProjection({
      attemptId: 'attempt',
      connectionId: 'connection',
      provider: 'openai-codex',
      phase: 'awaiting_authorization',
    }),
    {
      attemptId: 'attempt',
      connectionId: 'connection',
      provider: 'openai-codex',
      phase: 'awaiting_authorization',
    },
  );
});
