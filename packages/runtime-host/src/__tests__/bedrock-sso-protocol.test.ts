import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeClientFrame, decodeHostFrame } from '../protocol/index.js';

test('Bedrock SSO protocol exposes configuration and safe projections only', () => {
  assert.deepEqual(
    decodeClientFrame({
      requestId: 'request',
      operation: 'bedrock.sso.login.start',
      input: {
        attemptId: 'attempt',
        ssoStartUrl: 'https://example.awsapps.com/start',
        ssoRegion: 'us-east-1',
        region: 'us-west-2',
      },
    }),
    {
      requestId: 'request',
      operation: 'bedrock.sso.login.start',
      input: {
        attemptId: 'attempt',
        ssoStartUrl: 'https://example.awsapps.com/start',
        ssoRegion: 'us-east-1',
        region: 'us-west-2',
      },
    },
  );
  assert.deepEqual(
    decodeHostFrame({
      requestId: 'request',
      operation: 'bedrock.sso.login.start',
      ok: true,
      result: { attemptId: 'attempt', phase: 'awaiting_authorization', userCode: 'ABCD-EFGH' },
    }),
    {
      requestId: 'request',
      operation: 'bedrock.sso.login.start',
      ok: true,
      result: { attemptId: 'attempt', phase: 'awaiting_authorization', userCode: 'ABCD-EFGH' },
    },
  );
  assert.deepEqual(
    decodeHostFrame({
      requestId: 'models',
      operation: 'bedrock.sso.models.fetch',
      ok: true,
      result: {
        models: [
          {
            id: 'us.amazon.nova-pro-v1:0',
            displayName: 'Nova Pro (US)',
            capabilities: { chat: true, vision: true, functionCalling: true },
            modalities: { input: ['text', 'image'], output: ['text'] },
            bedrock: {
              kind: 'inference-profile',
              sourceModelIds: ['amazon.nova-pro-v1:0'],
            },
          },
        ],
      },
    }),
    {
      requestId: 'models',
      operation: 'bedrock.sso.models.fetch',
      ok: true,
      result: {
        models: [
          {
            id: 'us.amazon.nova-pro-v1:0',
            displayName: 'Nova Pro (US)',
            capabilities: { chat: true, vision: true, functionCalling: true },
            modalities: { input: ['text', 'image'], output: ['text'] },
            bedrock: {
              kind: 'inference-profile',
              sourceModelIds: ['amazon.nova-pro-v1:0'],
            },
          },
        ],
      },
    },
  );
  assert.throws(() =>
    decodeHostFrame({
      requestId: 'request',
      operation: 'bedrock.sso.login.start',
      ok: true,
      result: {
        attemptId: 'attempt',
        phase: 'authenticated',
        accessToken: 'must-not-cross-protocol',
      },
    }),
  );
});
