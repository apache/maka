import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isConnectionReady } from '../connection-readiness.js';
import type { LlmConnection } from '../llm-connections.js';

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
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
    ...overrides,
  };
}

describe('isConnectionReady — model capability gate', () => {
  it('rejects an explicitly image-only default model', () => {
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'gpt-image-1',
        models: [{ id: 'gpt-image-1', capabilities: { imageGeneration: true, chat: false } }],
      }),
      hasSecret: true,
    });

    assert.deepEqual(verdict, { ready: false, reason: 'model_not_chat_capable' });
  });

  it('rejects an explicitly image-only requested model even when the default is chat-capable', () => {
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'gpt-4.1',
        enabledModelIds: ['gpt-4.1', 'gpt-image-1'],
        models: [
          { id: 'gpt-4.1', capabilities: { chat: true, functionCalling: true } },
          { id: 'gpt-image-1', capabilities: { imageGeneration: true, chat: false } },
        ],
      }),
      hasSecret: true,
      requestedModel: 'gpt-image-1',
    });

    assert.deepEqual(verdict, { ready: false, reason: 'model_not_chat_capable' });
  });

  it('rejects a discovered model after the user disables it', () => {
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'gpt-4.1',
        enabledModelIds: ['gpt-4.1'],
        models: [
          { id: 'gpt-4.1', capabilities: { chat: true } },
          { id: 'gpt-4.1-mini', capabilities: { chat: true } },
        ],
      }),
      hasSecret: true,
      requestedModel: 'gpt-4.1-mini',
    });

    assert.deepEqual(verdict, { ready: false, reason: 'model_not_enabled' });
  });

  it('keeps explicit chat models send-ready even when they also support image generation', () => {
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'multimodal-chat',
        models: [{ id: 'multimodal-chat', capabilities: { chat: true, imageGeneration: true } }],
      }),
      hasSecret: true,
    });

    assert.deepEqual(verdict, { ready: true, model: 'multimodal-chat' });
  });

  it('does not block models with unknown capability metadata', () => {
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'custom-chat',
        models: [{ id: 'custom-chat' }],
      }),
      hasSecret: true,
    });

    assert.deepEqual(verdict, { ready: true, model: 'custom-chat' });
  });

  it('keeps optional-key LocalAI ready when no credential is stored', () => {
    const verdict = isConnectionReady({
      connection: connection({
        slug: 'localai',
        name: 'LocalAI',
        providerType: 'localai',
        defaultModel: 'qwen3-8b',
        models: [{ id: 'qwen3-8b' }],
      }),
      hasSecret: false,
    });

    assert.deepEqual(verdict, { ready: true, model: 'qwen3-8b' });
  });

  it('keeps Vercel Gateway gated on its key', () => {
    const vercel = connection({
      slug: 'vercel',
      name: 'Vercel AI Gateway',
      providerType: 'vercel',
      defaultModel: 'xai/grok-4.3',
      models: [{ id: 'xai/grok-4.3', capabilities: { chat: true, functionCalling: true } }],
    });

    assert.deepEqual(isConnectionReady({ connection: vercel, hasSecret: false }), {
      ready: false,
      reason: 'missing_api_key',
    });
  });

  it('treats an enumerated fallback model list as the local send gate', () => {
    const verdict = isConnectionReady({
      connection: connection({
        defaultModel: 'custom-chat',
        models: [{ id: 'relay-static-model' }],
        modelSource: 'fallback',
      }),
      hasSecret: true,
    });

    assert.deepEqual(verdict, { ready: false, reason: 'model_not_enabled' });
  });

  it('returns the normalized requested model id', () => {
    assert.deepEqual(
      isConnectionReady({
        connection: connection(),
        hasSecret: true,
        requestedModel: ' gpt-4.1 ',
      }),
      { ready: true, model: 'gpt-4.1' },
    );
  });
});
