import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultSettings } from '@maka/core';
import { VOICE_PAYLOAD_CHUNK_MAX_BYTES } from '@maka/runtime-host/protocol';
import { registerRuntimeHostVoiceIpc } from '../runtime-host-voice-ipc-main.js';

type Handler = (event: unknown, ...args: any[]) => unknown;

test('Runtime Host Voice IPC preserves the renderer contract over bounded payload chunks', async () => {
  const handlers = new Map<string, Handler>();
  const appended: Array<{ operationId: string; offset: number; bytes: Buffer }> = [];
  const captureId = '123e4567-e89b-12d3-a456-426614174000';
  const realtimeId = '123e4567-e89b-12d3-a456-426614174001';
  const client = {
    async beginVoiceCapture() {
      return {
        ok: true,
        operationId: captureId,
        expiresAt: 1,
        route: { kind: 'transcription_to_draft', target: target() },
      };
    },
    async appendVoicePayload(input: { operationId: string; offset: number; chunk: string }) {
      const bytes = Buffer.from(input.chunk, 'base64');
      appended.push({ operationId: input.operationId, offset: input.offset, bytes });
      return { receivedBytes: input.offset + bytes.byteLength };
    },
    async finishVoiceCapture(input: { operationId: string }) {
      return {
        kind: 'transcript',
        operationId: input.operationId,
        text: 'transcribed',
        providerLabel: 'Provider',
      };
    },
    async cancelVoiceOperation() {
      return { cancelled: true };
    },
    async beginVoiceRealtime() {
      return { operationId: realtimeId, expiresAt: 1 };
    },
    async finishVoiceRealtime() {
      return {
        sessionId: '123e4567-e89b-12d3-a456-426614174002',
        answerSdp: 'v=0\r\no=answer',
        model: 'realtime-model',
        providerLabel: 'Provider',
      };
    },
    async closeVoiceRealtime() {
      return { closed: true };
    },
  };

  registerRuntimeHostVoiceIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler as Handler) },
    client: client as never,
    settingsStore: { get: async () => createDefaultSettings() } as never,
  });

  const bytes = new Uint8Array(VOICE_PAYLOAD_CHUNK_MAX_BYTES + 7).fill(9);
  const result = await handlers.get('voice:finishCapture')?.({}, captureId, {
    bytes,
    mediaType: 'audio/wav',
    format: 'wav',
    durationMs: 1_000,
    sampleRate: 16_000,
    channels: 1,
  });
  assert.equal((result as { text: string }).text, 'transcribed');
  assert.deepEqual(
    appended.map(({ operationId, offset, bytes: chunk }) => ({
      operationId,
      offset,
      bytes: chunk.byteLength,
    })),
    [
      { operationId: captureId, offset: 0, bytes: VOICE_PAYLOAD_CHUNK_MAX_BYTES },
      { operationId: captureId, offset: VOICE_PAYLOAD_CHUNK_MAX_BYTES, bytes: 7 },
    ],
  );

  appended.length = 0;
  await handlers.get('voice:createRealtimeSession')?.({}, 'v=0\r\no=offer');
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.operationId, realtimeId);
  assert.equal(appended[0]?.bytes.toString(), 'v=0\r\no=offer');
});

function target() {
  return {
    connectionSlug: 'provider',
    modelId: 'transcribe-model',
    providerLabel: 'Provider',
    modalities: { input: ['audio'] as const, output: ['text'] as const },
    endpointRoles: ['transcription'] as const,
    transports: ['openai_audio_transcriptions'] as const,
    transcriptOutput: true,
    adapterReady: true,
  };
}
