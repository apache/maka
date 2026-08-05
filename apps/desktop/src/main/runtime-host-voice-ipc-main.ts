import type { IpcMain } from 'electron';
import {
  normalizeVoiceCoordinatorToolCall,
  type VoiceBeginRequest,
  type VoiceCapturedAudio,
} from '@maka/core';
import { VOICE_PAYLOAD_CHUNK_MAX_BYTES } from '@maka/runtime-host/protocol';
import type { SettingsStore } from '@maka/storage';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

type RuntimeHostVoiceClient = Pick<
  DesktopRuntimeHostClient,
  | 'appendVoicePayload'
  | 'beginVoiceCapture'
  | 'beginVoiceRealtime'
  | 'cancelVoiceOperation'
  | 'closeVoiceRealtime'
  | 'finishVoiceCapture'
  | 'finishVoiceRealtime'
>;

export function registerRuntimeHostVoiceIpc(input: {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly client: RuntimeHostVoiceClient;
  readonly settingsStore: SettingsStore;
}): void {
  input.ipcMain.handle('voice:begin', async (_event, request: VoiceBeginRequest) =>
    input.client.beginVoiceCapture({
      request,
      settings: (await input.settingsStore.get()).voice,
    }),
  );
  input.ipcMain.handle(
    'voice:finishCapture',
    async (_event, operationId: string, audio: VoiceCapturedAudio) => {
      await appendPayload(input.client, operationId, audio.bytes);
      return input.client.finishVoiceCapture({
        operationId,
        audio: {
          mediaType: audio.mediaType,
          format: audio.format,
          durationMs: audio.durationMs,
          sampleRate: audio.sampleRate,
          channels: audio.channels,
        },
      });
    },
  );
  input.ipcMain.handle('voice:cancel', async (_event, operationId: string) => {
    await input.client.cancelVoiceOperation({ operationId });
  });
  input.ipcMain.handle('voice:createRealtimeSession', async (_event, offerSdp: string) => {
    const operation = await input.client.beginVoiceRealtime({
      settings: (await input.settingsStore.get()).voice,
    });
    try {
      await appendPayload(input.client, operation.operationId, new TextEncoder().encode(offerSdp));
      return await input.client.finishVoiceRealtime({ operationId: operation.operationId });
    } catch (error) {
      await input.client
        .cancelVoiceOperation({ operationId: operation.operationId })
        .catch(() => undefined);
      throw error;
    }
  });
  input.ipcMain.handle('voice:closeRealtimeSession', async (_event, sessionId: string) => {
    await input.client.closeVoiceRealtime({ sessionId });
  });
  input.ipcMain.handle('voice:validateCoordinatorToolCall', (_event, call: unknown) =>
    normalizeVoiceCoordinatorToolCall(call),
  );
}

async function appendPayload(
  client: Pick<DesktopRuntimeHostClient, 'appendVoicePayload'>,
  operationId: string,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const end = Math.min(offset + VOICE_PAYLOAD_CHUNK_MAX_BYTES, bytes.byteLength);
    const result = await client.appendVoicePayload({
      operationId,
      offset,
      chunk: Buffer.from(bytes.subarray(offset, end)).toString('base64'),
    });
    if (result.receivedBytes !== end) {
      throw new Error('Runtime Host accepted an inconsistent Voice payload prefix');
    }
    offset = end;
  }
}
