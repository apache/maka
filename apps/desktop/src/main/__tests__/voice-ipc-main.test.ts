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
  now?: () => number;
}) {
  return createVoiceIpcService({
    settingsStore: { get: async () => input.settings } as never,
    connectionStore: {
      get: async (slug: string) => (slug === input.connection.slug ? input.connection : null),
    } as never,
    resolveConnectionSecret: async () => 'server-secret',
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  it('exchanges realtime SDP in main without exposing credentials and enforces one active lease', async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      body: BodyInit | null | undefined;
    }> = [];
    const fetchMock: typeof fetch = async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body,
      });
      if (String(url).endsWith('/realtime/client_secrets')) {
        return new Response(
          JSON.stringify({ value: 'ephemeral-client-secret', expires_at: 123 }),
          { status: 200 },
        );
      }
      return new Response('v=0\r\no=answer', { status: 200 });
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
    const offerSdp = 'v=0\r\no=offer';
    const session = await voice.createRealtimeSession(offerSdp);
    assert.equal(session.answerSdp, 'v=0\r\no=answer');
    assert.equal(JSON.stringify(session).includes('server-secret'), false);
    assert.equal(JSON.stringify(session).includes('ephemeral-client-secret'), false);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, 'https://api.openai.test/v1/realtime/client_secrets');
    assert.equal(requests[0]?.authorization, 'Bearer server-secret');
    assert.match(String(requests[0]?.body), /"model":"gpt-realtime"/);
    assert.deepEqual(requests[1], {
      url: 'https://api.openai.test/v1/realtime/calls',
      authorization: 'Bearer ephemeral-client-secret',
      body: offerSdp,
    });
    await assert.rejects(
      () => voice.createRealtimeSession(offerSdp),
      /voice_realtime_session_already_active/,
    );
    voice.closeRealtimeSession(session.sessionId);
    assert.equal((await voice.createRealtimeSession(offerSdp)).answerSdp, 'v=0\r\no=answer');
    await assert.rejects(
      () => service({
        settings: settings(),
        connection: connection(['gpt-realtime']),
      }).createRealtimeSession('not-sdp'),
      /voice_realtime_offer_invalid/,
    );
  });

  it('keeps realtime creation single-flight past its old deadline and releases admission on settle', async () => {
    let currentTime = 0;
    let requestCount = 0;
    let failNextToken = false;
    const tokenRequested = deferred<void>();
    const callRequested = deferred<void>();
    const tokenResponse = deferred<Response>();
    const callResponse = deferred<Response>();
    const fetchMock: typeof fetch = async (url) => {
      const requestIndex = requestCount;
      requestCount += 1;
      if (requestIndex === 0) {
        tokenRequested.resolve(undefined);
        return tokenResponse.promise;
      }
      if (requestIndex === 1) {
        callRequested.resolve(undefined);
        return callResponse.promise;
      }
      if (String(url).endsWith('/realtime/client_secrets')) {
        if (failNextToken) {
          failNextToken = false;
          return new Response('{}', { status: 200 });
        }
        return new Response(JSON.stringify({ value: 'next-client-secret', expires_at: 123 }), {
          status: 200,
        });
      }
      return new Response('v=0\r\no=next-answer', { status: 200 });
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
      now: () => currentTime,
    });
    const offerSdp = 'v=0\r\no=offer';

    const firstPending = voice.createRealtimeSession(offerSdp);
    await tokenRequested.promise;
    currentTime = 18_000;
    tokenResponse.resolve(
      new Response(JSON.stringify({ value: 'first-client-secret', expires_at: 123 }), {
        status: 200,
      }),
    );
    await callRequested.promise;

    currentTime = 31_000;
    await assert.rejects(
      () => voice.createRealtimeSession(offerSdp),
      /voice_realtime_session_already_active/,
    );
    assert.equal(requestCount, 2, 'the rejected request must not reach the provider');

    currentTime = 40_000;
    callResponse.resolve(new Response('v=0\r\no=first-answer', { status: 200 }));
    const first = await firstPending;
    voice.closeRealtimeSession(first.sessionId);

    failNextToken = true;
    await assert.rejects(
      () => voice.createRealtimeSession(offerSdp),
      /voice_realtime_secret_missing/,
    );
    const next = await voice.createRealtimeSession(offerSdp);
    assert.equal(next.answerSdp, 'v=0\r\no=next-answer');
    assert.notEqual(next.sessionId, first.sessionId);
  });
});
