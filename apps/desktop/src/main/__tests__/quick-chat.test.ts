/**
 * Tests for the Quick Chat handler (PR110b, narrowed by #1433).
 *
 * The handler now opens an EMPTY session in a given mode; drafting and
 * sending belong to the one Composer, which creates its own session on
 * first send. The gates that remain:
 *  - non-ready OnboardingState → `setup_required`, NO session created
 *  - ready state → create + announce exactly once, on the derived default
 *  - mode is normalized and forwarded to the create path
 *  - workspace failures keep their recovery semantics; any other create
 *    failure becomes `create_failed` with generalized Chinese copy
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { OnboardingState, SessionSummary } from '@maka/core';
import { handleQuickChatStart, type QuickChatDeps } from '../quick-chat.js';
import { SESSION_WORKSPACE_UNAVAILABLE_CODE } from '../project-context-root.js';

function workspaceUnavailableError(): Error {
  return new Error(`${SESSION_WORKSPACE_UNAVAILABLE_CODE}: unavailable`);
}

function fakeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: overrides.id ?? 'session-quickchat-1',
    name: overrides.name ?? 'New Chat',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-live',
    connectionLocked: false,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'ask',
    ...overrides,
  };
}

interface QuickChatSpy {
  createCalls: number;
  createInputs: Array<{ defaultConnectionSlug: string; defaultModel: string; mode: 'chat' | 'deep_research' }>;
  emitCalls: string[];
}

function makeDeps(overrides: Partial<QuickChatDeps> = {}): QuickChatDeps & { spy: QuickChatSpy } {
  const spy: QuickChatSpy = {
    createCalls: 0,
    createInputs: [],
    emitCalls: [],
  };
  const deps: QuickChatDeps = {
    async getOnboardingState() {
      return {
        kind: 'ready_empty',
        defaultConnectionSlug: 'anthropic-live',
        defaultModel: 'claude-sonnet-4-5-20250929',
      } as OnboardingState;
    },
    async createSession(input) {
      spy.createCalls += 1;
      spy.createInputs.push(input);
      return fakeSession();
    },
    emitCreated(sessionId) {
      spy.emitCalls.push(sessionId);
    },
    ...overrides,
  };
  return { ...deps, spy };
}

describe('handleQuickChatStart — setup_required path', () => {
  for (const state of [
    { kind: 'needs_connection' } as OnboardingState,
    { kind: 'needs_default_connection' } as OnboardingState,
    { kind: 'needs_connection_credentials', connectionSlug: 'a' } as OnboardingState,
    { kind: 'needs_default_model', connectionSlug: 'a' } as OnboardingState,
    { kind: 'blocked', reason: 'all_connections_unhealthy' } as OnboardingState,
  ]) {
    it(`returns setup_required for state.kind=${state.kind} and does NOT create a session`, async () => {
      const deps = makeDeps({ getOnboardingState: async () => state });
      const result = await handleQuickChatStart({ mode: 'chat' }, deps);
      assert.deepEqual(result, { ok: false, reason: 'setup_required', state });
      assert.equal(deps.spy.createCalls, 0, 'no session must be created in non-ready state');
      assert.equal(deps.spy.emitCalls.length, 0);
    });
  }

  it('re-derives readiness instead of trusting the caller', async () => {
    let reads = 0;
    const deps = makeDeps({
      async getOnboardingState() {
        reads += 1;
        return { kind: 'needs_connection' } as OnboardingState;
      },
    });
    await handleQuickChatStart({}, deps);
    assert.equal(reads, 1);
  });
});

describe('handleQuickChatStart — ready path', () => {
  it('creates and announces exactly one session on the derived default', async () => {
    const deps = makeDeps();
    const result = await handleQuickChatStart({}, deps);
    assert.deepEqual(result, { ok: true, sessionId: 'session-quickchat-1' });
    assert.equal(deps.spy.createCalls, 1);
    assert.deepEqual(deps.spy.emitCalls, ['session-quickchat-1']);
    assert.deepEqual(deps.spy.createInputs, [
      {
        defaultConnectionSlug: 'anthropic-live',
        defaultModel: 'claude-sonnet-4-5-20250929',
        mode: 'chat',
      },
    ]);
  });

  it('works from ready_with_history too', async () => {
    const deps = makeDeps({
      async getOnboardingState() {
        return {
          kind: 'ready_with_history',
          defaultConnectionSlug: 'anthropic-live',
          defaultModel: 'claude-sonnet-4-5-20250929',
        } as OnboardingState;
      },
    });
    const result = await handleQuickChatStart({}, deps);
    assert.equal(result.ok, true);
    assert.equal(deps.spy.createCalls, 1);
  });

  it('accepts undefined input without crashing', async () => {
    const deps = makeDeps();
    const result = await handleQuickChatStart(undefined, deps);
    assert.equal(result.ok, true);
    assert.equal(deps.spy.createInputs[0]?.mode, 'chat');
  });

  it('forwards deep_research and fails closed to chat for anything unrecognized', async () => {
    const deep = makeDeps();
    await handleQuickChatStart({ mode: 'deep_research' }, deep);
    assert.equal(deep.spy.createInputs[0]?.mode, 'deep_research');

    const junk = makeDeps();
    await handleQuickChatStart({ mode: 'execute' }, junk);
    assert.equal(junk.spy.createInputs[0]?.mode, 'chat');
  });

  it('ignores stray connectionSlug / model fields (no-override gate)', async () => {
    // @kenji PR110b review: Quick Chat does not support a
    // connection/model override. If a future renderer sends them, they
    // must NOT influence the derived defaults the session is created on.
    const deps = makeDeps();
    const tampered = {
      connectionSlug: 'malicious-slug',
      model: 'malicious-model',
    } as unknown;
    const result = await handleQuickChatStart(tampered, deps);
    assert.equal(result.ok, true);
    assert.deepEqual(deps.spy.createInputs, [
      {
        defaultConnectionSlug: 'anthropic-live',
        defaultModel: 'claude-sonnet-4-5-20250929',
        mode: 'chat',
      },
    ]);
  });
});

describe('handleQuickChatStart — create failures', () => {
  it('preserves an unavailable workspace as its own domain result', async () => {
    const deps = makeDeps({
      async createSession() {
        throw workspaceUnavailableError();
      },
    });
    const result = await handleQuickChatStart({}, deps);
    assert.deepEqual(result, { ok: false, reason: 'workspace_unavailable' });
    assert.deepEqual(deps.spy.emitCalls, [], 'a session that failed to create must not be announced');
  });

  it('generalizes any other create failure and never leaks the raw error', async () => {
    const deps = makeDeps({
      async createSession() {
        throw new Error('NO_REAL_CONNECTION:missing_api_key: 缺少 API key');
      },
    });
    const result = await handleQuickChatStart({}, deps);
    if (result.ok || result.reason !== 'create_failed') {
      assert.fail(`expected create_failed, got ${JSON.stringify(result)}`);
    }
    assert.match(result.message, /[一-鿿]/, 'message must be Chinese');
    assert.ok(!result.message.includes('NO_REAL_CONNECTION'), 'raw error code must not leak');
    assert.ok(!result.message.includes('missing_api_key'), 'raw reason must not leak');
    assert.deepEqual(deps.spy.emitCalls, []);
  });

  // @kenji + @xuan PR110b follow-up: each error category must produce a
  // Chinese-only message with no English or raw-token leak. The matrix
  // locks that contract for every category the classifier recognizes.
  for (const { name, raw, expected } of [
    { name: 'timeout', raw: 'Request timeout after 30s', expected: '请求超时' },
    { name: '429 rate limit', raw: 'HTTP 429 Too Many Requests', expected: '触发模型速率限制' },
    { name: '401 auth', raw: '401 Unauthorized: bad key', expected: '鉴权失败' },
    { name: '5xx', raw: 'Provider returned 500 Internal Server Error', expected: '模型服务返回错误' },
    { name: 'network', raw: 'ECONNREFUSED fetch failed', expected: '网络错误' },
  ]) {
    it(`create failure category ${name} → Chinese-only generalized message`, async () => {
      const deps = makeDeps({
        async createSession() {
          throw new Error(raw);
        },
      });
      const result = await handleQuickChatStart({}, deps);
      if (result.ok || result.reason !== 'create_failed') {
        assert.fail(`${name}: expected create_failed result`);
      }
      assert.equal(result.message, expected, `${name}: expected canonical Chinese category`);
      for (const eng of [
        'Request timed out',
        'Rate limit exceeded',
        'Authentication failed',
        'Provider returned an error',
        'Network error',
        'Operation failed',
      ]) {
        assert.equal(result.message.includes(eng), false, `${name} message leaked "${eng}"`);
      }
      assert.ok(!result.message.toLowerCase().includes('econnrefused'), `${name} message leaked ECONNREFUSED`);
    });
  }

  it('completely unknown error → Chinese fallback (no English leak)', async () => {
    const deps = makeDeps({
      async createSession() {
        throw new Error('something completely uncategorized happened');
      },
    });
    const result = await handleQuickChatStart({}, deps);
    if (result.ok || result.reason !== 'create_failed') {
      assert.fail('expected create_failed');
    }
    assert.equal(result.message, '无法创建会话，请稍后再试。');
    assert.equal(result.message.includes('Operation failed'), false);
    assert.equal(result.message.includes('something completely uncategorized'), false);
  });
});
