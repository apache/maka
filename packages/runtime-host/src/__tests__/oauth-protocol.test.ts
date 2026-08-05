import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  decodeOAuthPresentationRequest,
  decodeOAuthPresentationResult,
  OAUTH_PRESENTATION_AUTHORIZATION_CODE_MAX_LENGTH,
  RuntimeHostProtocolError,
} from '../protocol/index.js';

test('OAuth login protocol covers every Host-enrolled provider', () => {
  for (const provider of ['claude-subscription', 'openai-codex', 'xai-oauth']) {
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request',
        operation: 'oauth.login.query',
        ok: true,
        result: {
          attemptId: 'attempt',
          connectionId: 'connection',
          provider,
          phase: 'awaiting_authorization',
        },
      }),
      {
        requestId: 'request',
        operation: 'oauth.login.query',
        ok: true,
        result: {
          attemptId: 'attempt',
          connectionId: 'connection',
          provider,
          phase: 'awaiting_authorization',
        },
      },
    );
  }
});

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

test('OAuth account usage exposes only a bounded safe quota projection', () => {
  assert.deepEqual(
    decodeHostFrame({
      requestId: 'request',
      operation: 'oauth.account.usage.fetch',
      ok: true,
      result: {
        kind: 'available',
        provider: 'claude-subscription',
        quota: {
          fiveHour: { utilization: 25, resetsAt: '2026-08-05T12:00:00.000Z' },
          fetchedAt: 1,
        },
      },
    }),
    {
      requestId: 'request',
      operation: 'oauth.account.usage.fetch',
      ok: true,
      result: {
        kind: 'available',
        provider: 'claude-subscription',
        quota: {
          fiveHour: { utilization: 25, resetsAt: '2026-08-05T12:00:00.000Z' },
          fetchedAt: 1,
        },
      },
    },
  );
  assert.throws(
    () =>
      decodeHostFrame({
        requestId: 'request',
        operation: 'oauth.account.usage.fetch',
        ok: true,
        result: {
          kind: 'available',
          provider: 'claude-subscription',
          quota: {
            fiveHour: { utilization: 101, resetsAt: '' },
            fetchedAt: 1,
          },
        },
      }),
    (error: unknown) => error instanceof RuntimeHostProtocolError,
  );
});

test('OAuth presentation methods share one closed request and result contract', () => {
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
  assert.deepEqual(
    decodeOAuthPresentationResult('request_authorization_code', {
      kind: 'authorization_code',
      authorizationCode: 'code#state',
    }),
    { kind: 'authorization_code', authorizationCode: 'code#state' },
  );
  assert.throws(
    () =>
      decodeOAuthPresentationRequest('request_authorization_code', {
        url: 'https://auth.example/authorize',
      }),
    (error: unknown) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () =>
      decodeOAuthPresentationResult('request_authorization_code', {
        kind: 'authorization_code',
        authorizationCode: 'x'.repeat(OAUTH_PRESENTATION_AUTHORIZATION_CODE_MAX_LENGTH + 1),
      }),
    (error: unknown) => error instanceof RuntimeHostProtocolError,
  );
});
