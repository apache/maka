import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import {
  NO_REAL_CONNECTION_CODE,
  assertSessionCanSend,
  ensureSessionCanSendOrRebind,
  errorCode,
  requireReadyConnection,
  errorReason,
  shouldRebindSessionToDefault,
  type ReadyConnectionDeps,
} from '../chat-readiness.js';

describe('chat readiness guard', () => {
  test('blocks missing, fake, missing, disabled, and secretless model references', async () => {
    const table: Array<{
      name: string;
      slug: string | null | undefined;
      deps: ReadyConnectionDeps;
      includes: string;
      reason: string;
    }> = [
      {
        name: 'no default model',
        slug: null,
        deps: deps(),
        includes: '等待配置默认模型',
        reason: 'missing_default_connection',
      },
      {
        name: 'implicit fake slug',
        slug: 'fake',
        deps: deps(),
        includes: '等待配置默认模型',
        reason: 'missing_default_connection',
      },
      {
        name: 'malformed model ref',
        slug: 'missing',
        deps: deps(),
        includes: '找不到模型连接 "missing"',
        reason: 'connection_missing',
      },
      {
        name: 'disabled provider',
        slug: 'anthropic',
        deps: deps({ connection: connection({ enabled: false }), apiKey: 'sk-test' }),
        includes: '已禁用',
        reason: 'connection_disabled',
      },
      {
        name: 'provider requires secret but has none',
        slug: 'anthropic',
        deps: deps({ connection: connection(), apiKey: null }),
        includes: '等待填写 API key',
        reason: 'missing_api_key',
      },
      {
        name: 'OAuth provider requires login token',
        slug: 'claude-subscription',
        deps: deps({
          connection: connection({
            slug: 'claude-subscription',
            name: 'Claude OAuth',
            providerType: 'claude-subscription',
          }),
          apiKey: null,
        }),
        includes: '等待完成 OAuth 登录',
        reason: 'missing_api_key',
      },
    ];

    for (const entry of table) {
      await assertRejectsReadiness(entry.name, () => requireReadyConnection(entry.slug, entry.deps), entry.includes, entry.reason);
    }
  });

  test('blocks connections with no usable model or model outside enabled list', async () => {
    await assertRejectsReadiness(
      'blank default model',
      () => requireReadyConnection('custom', deps({
        connection: connection({ slug: 'custom', providerType: 'openai-compatible', defaultModel: '' }),
        apiKey: 'sk-test',
      })),
      '没有可用模型',
      'missing_model',
    );

    await assertRejectsReadiness(
      'empty model list',
      () => requireReadyConnection('custom', deps({
        connection: connection({ slug: 'custom', models: [] }),
        apiKey: 'sk-test',
      })),
      '没有启用任何模型',
      'empty_model_list',
    );

    await assertRejectsReadiness(
      'requested model outside enabled list',
      () => requireReadyConnection('custom', deps({
        connection: connection({
          slug: 'custom',
          defaultModel: 'glm-4.7',
          models: [{ id: 'glm-4.7' }],
        }),
        apiKey: 'sk-test',
      }), 'gpt-4o'),
      '不在连接 "Anthropic" 的启用模型列表中',
      'model_not_enabled',
    );

    await assertRejectsReadiness(
      'default model explicitly unsupported for chat',
      () => requireReadyConnection('custom', deps({
        connection: connection({
          slug: 'custom',
          defaultModel: 'gpt-image-1',
          models: [{ id: 'gpt-image-1', capabilities: { chat: false, imageGeneration: true } }],
        }),
        apiKey: 'sk-test',
      })),
      '不能用于聊天',
      'model_not_chat_capable',
    );
  });

  test('send path blocks explicit fake sessions and revalidates old ai sessions', async () => {
    await assertRejectsReadiness(
      'explicit fake session',
      () => assertSessionCanSend(header({ backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }), deps()),
      '旧的本地模拟连接',
      'fake_backend',
    );

    await assertRejectsReadiness(
      'old ai session after provider deletion',
      () => assertSessionCanSend(header({ llmConnectionSlug: 'deleted' }), deps()),
      '找不到模型连接 "deleted"',
      'connection_missing',
    );

    await assertRejectsReadiness(
      'old ai session after key removal',
      () => assertSessionCanSend(header(), deps({ connection: connection(), apiKey: null })),
      '等待填写 API key',
      'missing_api_key',
    );

    await assert.doesNotReject(() =>
      assertSessionCanSend(header(), deps({ connection: connection(), apiKey: 'sk-test' })),
    );
  });

  test('model_not_enabled names the requested model instead of the default', async () => {
    await assert.rejects(
      () => requireReadyConnection(
        'anthropic',
        deps({
          connection: connection({
            defaultModel: 'claude-3-5-sonnet-20241022',
            models: [{ id: 'claude-3-5-sonnet-20241022' }],
          }),
          apiKey: 'sk-test',
        }),
        'gpt-4o-NOT-IN-LIST',
      ),
      (error) => {
        const message = (error as Error).message;
        assert.match(message, /gpt-4o-NOT-IN-LIST/, 'requested model must appear in error copy');
        assert.doesNotMatch(message, /claude-3-5-sonnet-20241022/, 'defaultModel must NOT leak into requested-model error');
        assert.equal(errorReason(error), 'model_not_enabled');
        return true;
      },
    );
  });

  test('credential validation status does not gate a real send attempt', async () => {
    const ready = await requireReadyConnection(
      'anthropic',
      deps({
        connection: connection({ lastTestStatus: 'error' }),
        apiKey: 'sk-test',
      }),
    );
    assert.equal(ready.connection.slug, 'anthropic');
    assert.equal(ready.model, 'claude-3-5-sonnet-20241022');
  });

  test('classifies stale sessions that can be rebound to the current default model', () => {
    assert.equal(shouldRebindSessionToDefault('model_not_enabled'), true);
    assert.equal(shouldRebindSessionToDefault('missing_api_key'), false);
    assert.equal(shouldRebindSessionToDefault(undefined), false);
  });

  test('rebinds stale ai-sdk sessions to a ready default connection before send', async () => {
    const updates: unknown[] = [];
    const result = await ensureSessionCanSendOrRebind(
      'session-1',
      header({ llmConnectionSlug: 'fake-claude', model: 'fake-model' }),
      {
        readyConnectionDeps: keyedDeps({
          'zai-coding-plan': {
            connection: connection({
              slug: 'zai-coding-plan',
              name: 'Z.AI Coding Plan',
              providerType: 'zai-coding-plan',
              defaultModel: 'glm-4.7',
              models: [{ id: 'glm-4.7' }],
            }),
            apiKey: 'sk-zai',
          },
        }),
        async getDefaultSlug() {
          return 'zai-coding-plan';
        },
        async listConnectionSlugs() {
          return [];
        },
        async updateSession(_sessionId, patch) {
          updates.push(patch);
        },
      },
    );

    assert.deepEqual(result, { rebound: true, connectionSlug: 'zai-coding-plan', modelId: 'glm-4.7' });
    assert.deepEqual(updates, [{
      backend: 'ai-sdk',
      llmConnectionSlug: 'zai-coding-plan',
      model: 'glm-4.7',
      connectionLocked: true,
    }]);
  });

  test('does not rebind locked sessions when their sticky model becomes invalid', async () => {
    const updates: unknown[] = [];

    await assertRejectsReadiness(
      'locked sticky model outside enabled list',
      () => ensureSessionCanSendOrRebind(
        'session-locked',
        header({
          connectionLocked: true,
          llmConnectionSlug: 'anthropic',
          model: 'claude-old-sticky',
        }),
        {
          readyConnectionDeps: keyedDeps({
            anthropic: {
              connection: connection({
                slug: 'anthropic',
                defaultModel: 'claude-new-default',
                models: [{ id: 'claude-new-default' }],
              }),
              apiKey: 'sk-test',
            },
            'zai-coding-plan': {
              connection: connection({
                slug: 'zai-coding-plan',
                name: 'Z.AI Coding Plan',
                providerType: 'zai-coding-plan',
                defaultModel: 'glm-4.7',
                models: [{ id: 'glm-4.7' }],
              }),
              apiKey: 'sk-zai',
            },
          }),
          async getDefaultSlug() {
            return 'zai-coding-plan';
          },
          async listConnectionSlugs() {
            return [];
          },
          async updateSession(_sessionId, patch) {
            updates.push(patch);
          },
        },
      ),
      'claude-old-sticky',
      'model_not_enabled',
    );

    assert.deepEqual(updates, []);
  });

  test('rebinds an unknown-provider session to the first existing ready connection', async () => {
    const updates: unknown[] = [];
    const rebindDeps = {
      readyConnectionDeps: keyedDeps({
        'branch-only-provider': {
          connection: connection({
            slug: 'branch-only-provider',
            name: 'Branch-only provider',
            providerType: 'branch-only-provider' as never,
            defaultModel: 'branch-model',
          }),
          apiKey: 'gsk-test',
        },
        anthropic: { connection: connection(), apiKey: 'sk-test' },
      }),
      async getDefaultSlug() {
        return 'branch-only-provider';
      },
      async listConnectionSlugs() {
        return ['branch-only-provider', 'anthropic'];
      },
      async updateSession(_sessionId: string, patch: unknown) {
        updates.push(patch);
      },
    };

    const result = await ensureSessionCanSendOrRebind(
      'session-unknown-provider',
      header({ llmConnectionSlug: 'branch-only-provider', model: 'branch-model' }),
      rebindDeps,
    );

    assert.deepEqual(result, {
      rebound: true,
      connectionSlug: 'anthropic',
      modelId: 'claude-3-5-sonnet-20241022',
    });
    assert.equal(updates.length, 1);
  });

  test('keeps the original readiness error when no ready default exists for rebind', async () => {
    await assertRejectsReadiness(
      'fake session without ready default',
      () => ensureSessionCanSendOrRebind(
        'session-1',
        header({ backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }),
        {
          readyConnectionDeps: keyedDeps({}),
          async getDefaultSlug() {
            return null;
          },
          async listConnectionSlugs() {
            return ['missing'];
          },
          async updateSession() {
            throw new Error('must not update');
          },
        },
      ),
      '旧的本地模拟连接',
      'fake_backend',
    );
  });

});

async function assertRejectsReadiness(name: string, fn: () => Promise<unknown>, includes: string, reason: string): Promise<void> {
  await assert.rejects(
    fn,
    (error) => {
      assert.equal(errorCode(error), NO_REAL_CONNECTION_CODE, name);
      assert.equal(errorReason(error), reason, name);
      assert.match((error as Error).message, new RegExp(escapeRegExp(includes)), name);
      return true;
    },
  );
}

function deps(input: { connection?: LlmConnection | null; apiKey?: string | null } = {}): ReadyConnectionDeps {
  return {
    async getConnection(_slug: string) {
      return input.connection ?? null;
    },
    async getApiKey(_slug: string) {
      return input.apiKey ?? null;
    },
  };
}

function keyedDeps(entries: Record<string, { connection: LlmConnection; apiKey?: string | null }>): ReadyConnectionDeps {
  return {
    async getConnection(slug: string) {
      return entries[slug]?.connection ?? null;
    },
    async getApiKey(slug: string) {
      return entries[slug]?.apiKey ?? null;
    },
  };
}

function connection(patch: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'anthropic',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'claude-3-5-sonnet-20241022',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function header(patch: Partial<SessionHeader> = {}): Pick<SessionHeader, 'backend' | 'llmConnectionSlug' | 'model' | 'connectionLocked'> {
  return {
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    connectionLocked: false,
    ...patch,
  };
}

describe('send-gate fact resolution stays staged', () => {
  test('a healthy send resolves only its own connection facts', async () => {
    const secretReads: string[] = [];
    const result = await ensureSessionCanSendOrRebind(
      'session-1',
      header(),
      {
        readyConnectionDeps: {
          async getConnection(slug: string) {
            return slug === 'anthropic' ? connection() : connection({ slug });
          },
          async getApiKey(slug: string) {
            secretReads.push(slug);
            if (slug === 'unrelated') throw new Error('credential store blew up');
            return 'sk-test';
          },
        },
        async getDefaultSlug() {
          throw new Error('default store must not be read');
        },
        async listConnectionSlugs() {
          throw new Error('connection list must not be read');
        },
        async updateSession() {
          throw new Error('must not rebind');
        },
      },
    );

    assert.deepEqual(result, { rebound: false });
    assert.deepEqual(secretReads, ['anthropic'], 'only the session’s own connection is probed on the healthy path');
  });

  test('rebind picks the first ready candidate in persisted order, not async completion order', async () => {
    const delays: Record<string, number> = { 'default-broken': 0, 'slow-first': 30, 'fast-second': 1 };
    const bySlug = {
      'default-broken': connection({ slug: 'default-broken', enabled: false }),
      'slow-first': connection({ slug: 'slow-first' }),
      'fast-second': connection({ slug: 'fast-second' }),
    } as Record<string, LlmConnection>;
    const updates: unknown[] = [];
    const result = await ensureSessionCanSendOrRebind(
      'session-1',
      header({ backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }),
      {
        readyConnectionDeps: {
          async getConnection(slug: string) {
            await new Promise((resolve) => setTimeout(resolve, delays[slug] ?? 0));
            return bySlug[slug] ?? null;
          },
          async getApiKey() {
            return 'sk-test';
          },
        },
        async getDefaultSlug() {
          return 'default-broken';
        },
        async listConnectionSlugs() {
          return ['default-broken', 'slow-first', 'fast-second'];
        },
        async updateSession(_id, patch) {
          updates.push(patch);
        },
      },
    );

    assert.deepEqual(result, { rebound: true, connectionSlug: 'slow-first', modelId: 'claude-3-5-sonnet-20241022' });
    assert.equal(updates.length, 1);
  });

  test('rebind walk stops probing after the first ready candidate, so a hanging later candidate cannot stall recovery', async () => {
    const secretReads: string[] = [];
    const updates: unknown[] = [];
    const gate = ensureSessionCanSendOrRebind(
      'session-1',
      header({ backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }),
      {
        readyConnectionDeps: {
          async getConnection(slug: string) {
            return connection({ slug });
          },
          async getApiKey(slug: string) {
            secretReads.push(slug);
            if (slug === 'hanging-oauth') return new Promise<never>(() => {});
            return 'sk-test';
          },
        },
        async getDefaultSlug() {
          return 'ready-default';
        },
        async listConnectionSlugs() {
          return ['ready-default', 'hanging-oauth'];
        },
        async updateSession(_id, patch) {
          updates.push(patch);
        },
      },
    );
    const outcome = await Promise.race([
      gate,
      new Promise((resolve) => setTimeout(() => resolve('timed_out'), 500)),
    ]);

    assert.deepEqual(outcome, { rebound: true, connectionSlug: 'ready-default', modelId: 'claude-3-5-sonnet-20241022' });
    assert.equal(updates.length, 1);
    assert.deepEqual(secretReads, ['ready-default'], 'candidates after the first ready one must never be probed');
  });

  test('rebind walk skips candidates whose facts cannot be read', async () => {
    const result = await ensureSessionCanSendOrRebind(
      'session-1',
      header({ backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }),
      {
        readyConnectionDeps: {
          async getConnection(slug: string) {
            if (slug === 'flaky') throw new Error('read failed');
            return slug === 'anthropic' ? connection() : null;
          },
          async getApiKey() {
            return 'sk-test';
          },
        },
        async getDefaultSlug() {
          return 'flaky';
        },
        async listConnectionSlugs() {
          return ['flaky', 'anthropic'];
        },
        async updateSession() {},
      },
    );

    assert.deepEqual(result, { rebound: true, connectionSlug: 'anthropic', modelId: 'claude-3-5-sonnet-20241022' });
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
