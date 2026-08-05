import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultVoiceSettings, type EphemeralVoiceAudio } from '@maka/core';
import type { VoiceService } from '@maka/runtime/voice-service';
import { HostVoiceCoordinator } from '../server/voice-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const captureId = '123e4567-e89b-12d3-a456-426614174000';
const realtimeSessionId = '123e4567-e89b-12d3-a456-426614174001';
const settings = defaultVoiceSettings();

test('Host Voice keeps payloads connection-bound and transfers native audio exactly once', async () => {
  let staged: EphemeralVoiceAudio | undefined;
  const voice = fakeVoiceService({
    finishCapture: async (operationId, input) => {
      assert.equal(operationId, captureId);
      staged = input as EphemeralVoiceAudio;
      return { kind: 'native_audio_ready', operationId: captureId, providerLabel: 'Provider' };
    },
    consumeNativeAudioOperation: (input) => {
      assert.equal(input.operationId, captureId);
      if (input.model !== 'audio-model') throw new Error('voice_operation_target_changed');
      assert.ok(staged);
      return staged;
    },
  });
  const coordinator = createCoordinator(voice);
  const started = await coordinator.handlers['voice.capture.begin'](
    {
      request: {
        intent: 'send_task',
        currentAgent: { connectionSlug: 'provider', model: 'audio-model' },
      },
      settings,
    },
    context('client-a'),
  );
  assert.equal(started.ok, true);

  const first = Buffer.from('first-');
  const second = Buffer.from('second');
  assert.deepEqual(
    await coordinator.handlers['voice.payload.append'](
      { operationId: captureId, offset: 0, chunk: first.toString('base64') },
      context('client-a'),
    ),
    { ok: true, result: { receivedBytes: first.byteLength } },
  );
  assert.equal(
    (
      await coordinator.handlers['voice.payload.append'](
        { operationId: captureId, offset: first.byteLength, chunk: second.toString('base64') },
        context('client-b'),
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await coordinator.handlers['voice.payload.append'](
        { operationId: captureId, offset: 0, chunk: second.toString('base64') },
        context('client-a'),
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await coordinator.handlers['voice.payload.append'](
        { operationId: captureId, offset: first.byteLength, chunk: second.toString('base64') },
        context('client-a'),
      )
    ).ok,
    true,
  );
  const finished = await coordinator.handlers['voice.capture.finish'](
    {
      operationId: captureId,
      audio: {
        mediaType: 'audio/wav',
        format: 'wav',
        durationMs: 500,
        sampleRate: 16_000,
        channels: 1,
      },
    },
    context('client-a'),
  );
  assert.equal(finished.ok, true);
  assert.equal(Buffer.from(staged!.bytes).toString(), 'first-second');
  assert.throws(() =>
    coordinator.consumeNativeAudio({
      operationId: captureId,
      connectionSlug: 'provider',
      model: 'audio-model',
      ownerConnectionId: 'client-b',
    }),
  );
  assert.throws(() =>
    coordinator.consumeNativeAudio({
      operationId: captureId,
      connectionSlug: 'provider',
      model: 'changed-model',
      ownerConnectionId: 'client-a',
    }),
  );
  assert.equal(
    Buffer.from(
      coordinator.consumeNativeAudio({
        operationId: captureId,
        connectionSlug: 'provider',
        model: 'audio-model',
        ownerConnectionId: 'client-a',
      }).bytes,
    ).toString(),
    'first-second',
  );
  assert.throws(() =>
    coordinator.consumeNativeAudio({
      operationId: captureId,
      connectionSlug: 'provider',
      model: 'audio-model',
      ownerConnectionId: 'client-a',
    }),
  );
});

test('Host Voice chunks realtime SDP without exposing one client lease to another', async () => {
  let offer = '';
  let closed = 0;
  const voice = fakeVoiceService({
    createRealtimeSession: async (input) => {
      offer = String(input);
      return {
        sessionId: realtimeSessionId,
        answerSdp: 'v=0\r\no=answer',
        model: 'realtime-model',
        providerLabel: 'Provider',
      };
    },
    closeRealtimeSession: () => {
      closed += 1;
    },
  });
  const coordinator = createCoordinator(voice);
  const begin = await coordinator.handlers['voice.realtime.begin'](
    { settings },
    context('client-a'),
  );
  assert.equal(begin.ok, true);
  if (!begin.ok) return;
  const operationId = begin.result.operationId;
  const bytes = Buffer.from('v=0\r\no=offer');
  assert.equal(
    (
      await coordinator.handlers['voice.payload.append'](
        { operationId, offset: 0, chunk: bytes.toString('base64') },
        context('client-a'),
      )
    ).ok,
    true,
  );
  const finished = await coordinator.handlers['voice.realtime.finish'](
    { operationId },
    context('client-a'),
  );
  assert.equal(finished.ok, true);
  assert.equal(offer, 'v=0\r\no=offer');
  assert.equal(
    (
      await coordinator.handlers['voice.realtime.close'](
        { sessionId: realtimeSessionId },
        context('client-b'),
      )
    ).ok,
    false,
  );
  assert.deepEqual(
    await coordinator.handlers['voice.realtime.close'](
      { sessionId: realtimeSessionId },
      context('client-a'),
    ),
    { ok: true, result: { closed: true } },
  );
  assert.equal(closed, 1);
});

test('Host Voice rejects malformed realtime bytes as client input and consumes the upload', async () => {
  const coordinator = createCoordinator(fakeVoiceService({}));
  const begin = await coordinator.handlers['voice.realtime.begin'](
    { settings },
    context('client-a'),
  );
  assert.equal(begin.ok, true);
  if (!begin.ok) return;
  const operationId = begin.result.operationId;
  const appended = await coordinator.handlers['voice.payload.append'](
    { operationId, offset: 0, chunk: Buffer.from([0xc3, 0x28]).toString('base64') },
    context('client-a'),
  );
  assert.equal(appended.ok, true);

  const finished = await coordinator.handlers['voice.realtime.finish'](
    { operationId },
    context('client-a'),
  );
  assert.equal(finished.ok, false);
  if (!finished.ok) assert.equal(finished.error.code, 'invalid_request');
  const retry = await coordinator.handlers['voice.realtime.finish'](
    { operationId },
    context('client-a'),
  );
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.equal(retry.error.code, 'not_found');
});

function createCoordinator(voice: VoiceService): HostVoiceCoordinator {
  return new HostVoiceCoordinator({
    runtimePolicy: {} as never,
    oauthCredentials: {} as never,
    voice,
  });
}

function fakeVoiceService(overrides: Partial<VoiceService>): VoiceService {
  return {
    begin: async () => ({
      ok: true,
      operationId: captureId,
      expiresAt: Date.now() + 60_000,
      route: {
        kind: 'native_audio_task',
        transcriptProjection: 'marker_only',
        target: {
          connectionSlug: 'provider',
          modelId: 'audio-model',
          providerLabel: 'Provider',
          modalities: { input: ['audio'], output: ['text'] },
          endpointRoles: ['audio_chat'],
          transports: ['openai_chat_audio'],
          transcriptOutput: false,
          adapterReady: true,
        },
      },
    }),
    finishCapture: async () => {
      throw new Error('unexpected finishCapture');
    },
    cancel: () => undefined,
    createRealtimeSession: async () => {
      throw new Error('unexpected createRealtimeSession');
    },
    closeRealtimeSession: () => undefined,
    validateCoordinatorToolCall: () => {
      throw new Error('unexpected validateCoordinatorToolCall');
    },
    consumeNativeAudioOperation: () => {
      throw new Error('unexpected consumeNativeAudioOperation');
    },
    ...overrides,
  };
}

function context(connectionId: string): ConnectionContext {
  return {
    hostEpoch: 'host-epoch',
    connectionId,
    surface: 'desktop',
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => undefined }),
  };
}
