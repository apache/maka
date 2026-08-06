/**
 * #1038 — session health notice derivation, aligned with send authority.
 *
 * Main projects send readiness and carries it in the onboarding snapshot.
 * These tests cover only the renderer's outcome-to-copy mapping and reminder
 * priority; send/rebind decision cases live in session-send-projection.test.ts.
 *
 * `lastTestStatus` is an intentional pre-send reminder (product contract
 * decided in #1038): it never claims send is blocked — E4 locks that it
 * must not gate send — so it only ever renders as a `warning` with copy
 * that says the send is not intercepted, and only when the projection
 * says the session's own connection will actually serve the next send.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core';
import {
  deriveSessionHealthNotice,
  type SessionHealthNoticeInput,
} from '../../renderer/session-health-notice.js';

function connection(): LlmConnection {
  return {
    slug: 'openai-live',
    name: 'OpenAI Live',
    providerType: 'openai',
    defaultModel: 'gpt-4.1',
    enabled: true,
    models: [{ id: 'gpt-4.1', capabilities: { chat: true, functionCalling: true } }],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
  } as LlmConnection;
}

function input(partial: Partial<SessionHealthNoticeInput> = {}): SessionHealthNoticeInput {
  return {
    locale: 'zh',
    session: {
      backend: 'ai-sdk',
      llmConnectionSlug: 'openai-live',
      model: 'gpt-4.1',
      connectionLocked: false,
    },
    outcome: { kind: 'ready' },
    connections: [connection()],
    lastTestStatus: undefined,
    ...partial,
  };
}

describe('deriveSessionHealthNotice', () => {
  it('returns undefined when no active session', () => {
    assert.equal(deriveSessionHealthNotice(input({ session: undefined })), undefined);
  });

  it('stays hidden when the snapshot outcome is unavailable', () => {
    assert.equal(deriveSessionHealthNotice(input({ outcome: undefined })), undefined);
  });

  it('returns undefined when the next send will succeed', () => {
    assert.equal(deriveSessionHealthNotice(input({})), undefined);
  });

  it('stays hidden when main projects a silent rebind', () => {
    assert.equal(
      deriveSessionHealthNotice(
        input({
          outcome: { kind: 'rebind', connectionSlug: 'openai-live', model: 'gpt-4.1' },
        }),
      ),
      undefined,
    );
  });

  describe('blocked outcomes', () => {
    it('renders the fake-backend recovery copy without internal terminology', () => {
      const result = deriveSessionHealthNotice(input({
        session: {
          backend: 'fake',
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          connectionLocked: false,
        },
        outcome: { kind: 'blocked', reason: 'fake_backend', connectionLocked: false },
      }));
      assert.equal(result?.tone, 'destructive');
      assert.equal(result?.label, '会话已过期 · 请先配置真实模型');
      assert.equal(result?.onClickTarget, 'models');
      assert.doesNotMatch(result?.label ?? '', /演示版|fake|FakeBackend/i);
      assert.doesNotMatch(result?.tooltip ?? '', /演示版|fake|FakeBackend/i);
    });

    it('renders the missing-connection recovery copy', () => {
      const result = deriveSessionHealthNotice(
        input({
          session: {
            backend: 'ai-sdk',
            llmConnectionSlug: 'deleted-slug',
            model: 'gpt-4.1',
            connectionLocked: false,
          },
          outcome: { kind: 'blocked', reason: 'connection_missing', connectionLocked: false },
        }),
      );
      assert.equal(result?.tone, 'destructive');
      assert.equal(result?.label, '连接已删除');
      assert.match(result?.tooltip ?? '', /设置.*模型/);
    });

    it('names the session connection when its API key is missing', () => {
      const result = deriveSessionHealthNotice(
        input({
          outcome: { kind: 'blocked', reason: 'missing_api_key', connectionLocked: false },
        }),
      );
      assert.equal(result?.tone, 'destructive');
      assert.equal(result?.label, '连接缺少密钥');
      assert.match(result?.tooltip ?? '', /OpenAI Live/);
    });
  });

  describe('lastTestStatus — honest pre-send reminder (never claims blocked)', () => {
    it('needs_reauth → warning · open models · does not claim send is blocked', () => {
      const result = deriveSessionHealthNotice(input({ lastTestStatus: 'needs_reauth' }));
      assert.equal(result?.tone, 'warning');
      assert.equal(result?.label, '上次连接测试鉴权失败');
      assert.equal(result?.onClickTarget, 'models');
      assert.match(result?.tooltip ?? '', /401|403|鉴权/);
      assert.match(result?.tooltip ?? '', /不会拦截发送/);
    });

    it('error → warning (not destructive) · open models · does not claim send is blocked', () => {
      const result = deriveSessionHealthNotice(input({ lastTestStatus: 'error' }));
      assert.equal(result?.tone, 'warning');
      assert.equal(result?.label, '上次连接测试失败');
      assert.equal(result?.onClickTarget, 'models');
      assert.match(result?.tooltip ?? '', /5xx|网络|超时|Base URL|代理/);
      assert.match(result?.tooltip ?? '', /不会拦截发送/);
    });

    it('verified → no notice', () => {
      assert.equal(deriveSessionHealthNotice(input({ lastTestStatus: 'verified' })), undefined);
    });

    it('a blocked send beats the reminder', () => {
      const result = deriveSessionHealthNotice(
        input({
          outcome: { kind: 'blocked', reason: 'missing_api_key', connectionLocked: false },
          lastTestStatus: 'error',
        }),
      );
      assert.equal(result?.label, '连接缺少密钥');
    });

    it('the reminder stays silent when the send will rebind away from this connection', () => {
      const result = deriveSessionHealthNotice(
        input({
          outcome: { kind: 'rebind', connectionSlug: 'second-ready', model: 'gpt-4.1' },
          lastTestStatus: 'error',
        }),
      );
      assert.equal(result, undefined);
    });
  });
});
