import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDefaultSettings, type AppSettings, type LlmConnection } from '@maka/core';
import { createVoiceIpcService } from '../voice-ipc-main.js';

function connection(models: string[]): LlmConnection {
  return {
    slug: 'openai',
    name: 'OpenAI',
    providerType: 'openai',
    enabled: true,
    baseUrl: 'https://api.openai.test/v1',
    defaultModel: models[0] ?? 'gpt-4.1',
    enabledModelIds: models,
    models: models.map((id) => ({ id })),
    createdAt: 1,
    updatedAt: 1,
  };
}

function settings(patch?: Partial<AppSettings['voice']>): AppSettings {
  const value = createDefaultSettings();
  return {
    ...value,
    voice: {
      recognition: {
        ...value.voice.recognition,
        ...patch?.recognition,
      },
      realtime: {
        ...value.voice.realtime,
        ...patch?.realtime,
      },
    },
  };
}

function service(input: {
  settings: AppSettings;
  connection: LlmConnection;
  fetch?: typeof fetch;
}) {
  return createVoiceIpcService({
    settingsStore: { get: async () => input.settings } as never,
    connectionStore: {
      get: async (slug: string) => (slug === input.connection.slug ? input.connection : null),
    } as never,
    resolveConnectionSecret: async () => 'server-secret',
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}

const audio = {
  bytes: new Uint8Array([82, 73, 70, 70]),
  mediaType: 'audio/wav',
  format: 'wav' as const,
  durationMs: 500,
  sampleRate: 16_000,
  channels: 1,
};

describe('voice IPC service', () => {
  it('fails closed when speech recognition is not configured', async () => {
    const voice = service({
      settings: settings(),
      connection: connection(['gpt-4.1']),
    });
    assert.deepEqual(await voice.begin({ intent: 'dictate' }), {
      ok: false,
      reason: 'recognition_not_configured',
    });
  });

  it('rejects malformed begin requests at the trusted IPC boundary', async () => {
    const voice = service({
      settings: settings(),
      connection: connection(['gpt-4.1']),
    });
    await assert.rejects(() => voice.begin(null as never), /voice_begin_invalid/);
    await assert.rejects(
      () => voice.begin({ intent: 'send_task', currentAgent: { connectionSlug: '', model: '' } }),
      /voice_begin_invalid/,
    );
  });

  it('transcribes through the configured connection and never returns its key', async () => {
    let request: { url: string; authorization?: string; body?: FormData };
    const fetchMock: typeof fetch = async (url, init) => {
      request = {
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
        body: init?.body as FormData,
      };
      return new Response(JSON.stringify({ text: '  hello from voice  ' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const voice = service({
      settings: settings({
        recognition: {
          connectionSlug: 'openai',
          model: 'gpt-4o-mini-transcribe',
          language: 'en',
          prompt: 'Maka',
        },
      }),
      connection: connection(['gpt-4o-mini-transcribe']),
      fetch: fetchMock,
    });
    const begin = await voice.begin({ intent: 'dictate' });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;
    const result = await voice.finishCapture(begin.operationId, audio);
    assert.deepEqual(result, {
      kind: 'transcript',
      operationId: begin.operationId,
      text: 'hello from voice',
      providerLabel: 'OpenAI',
    });
    assert.equal(request!.url, 'https://api.openai.test/v1/audio/transcriptions');
    assert.equal(request!.authorization, 'Bearer server-secret');
    assert.equal(request!.body?.get('model'), 'gpt-4o-mini-transcribe');
    assert.equal(JSON.stringify(result).includes('server-secret'), false);
  });

  it('aborts an in-flight transcription when the operation is cancelled', async () => {
    const fetchMock: typeof fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason ?? new Error('aborted'));
          return;
        }
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason ?? new Error('aborted')),
          { once: true },
        );
      });
    const voice = service({
      settings: settings({
        recognition: {
          connectionSlug: 'openai',
          model: 'gpt-4o-mini-transcribe',
          language: '',
          prompt: '',
        },
      }),
      connection: connection(['gpt-4o-mini-transcribe']),
      fetch: fetchMock,
    });
    const begin = await voice.begin({ intent: 'dictate' });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;
    const pending = voice.finishCapture(begin.operationId, audio);
    voice.cancel(begin.operationId);
    await assert.rejects(() => pending);
  });

  it('stages native audio once and binds it to the selected connection/model', async () => {
    const voice = service({
      settings: settings(),
      connection: connection(['gpt-audio']),
    });
    const begin = await voice.begin({
      intent: 'send_task',
      currentAgent: { connectionSlug: 'openai', model: 'gpt-audio' },
    });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;
    assert.equal((await voice.finishCapture(begin.operationId, audio)).kind, 'native_audio_ready');
    assert.throws(() =>
      voice.consumeNativeAudioOperation({
        operationId: begin.operationId,
        connectionSlug: 'openai',
        model: 'gpt-audio-mini',
      }),
    );
    const consumed = voice.consumeNativeAudioOperation({
      operationId: begin.operationId,
      connectionSlug: 'openai',
      model: 'gpt-audio',
    });
    assert.equal(consumed.retention, 'operation_memory');
    assert.throws(() =>
      voice.consumeNativeAudioOperation({
        operationId: begin.operationId,
        connectionSlug: 'openai',
        model: 'gpt-audio',
      }),
    );
  });

  it('returns only an ephemeral realtime token and enforces one active lease', async () => {
    const fetchMock: typeof fetch = async (_url, init) => {
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer server-secret',
      );
      return new Response(
        JSON.stringify({ value: 'ephemeral-client-secret', expires_at: 123 }),
        { status: 200 },
      );
    };
    const voice = service({
      settings: settings({
        realtime: {
          connectionSlug: 'openai',
          model: 'gpt-realtime',
          voice: 'marin',
        },
      }),
      connection: connection(['gpt-realtime']),
      fetch: fetchMock,
    });
    const session = await voice.createRealtimeSession();
    assert.equal(session.clientSecret, 'ephemeral-client-secret');
    assert.equal(JSON.stringify(session).includes('server-secret'), false);
    await assert.rejects(() => voice.createRealtimeSession());
    voice.closeRealtimeSession(session.sessionId);
    assert.equal((await voice.createRealtimeSession()).clientSecret, 'ephemeral-client-secret');
  });
});
