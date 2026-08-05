import type { IpcMain } from 'electron';
import type {
  VoiceBeginRequest,
  VoiceBeginResult,
  VoiceCapturedAudio,
  VoiceCoordinatorToolCall,
  VoiceFinishCaptureResult,
  VoiceRealtimeClientSession,
} from '@maka/core';
import { providerAuthRequiresSecret } from '@maka/core/llm-connections';
import {
  createVoiceService,
  type VoiceService,
} from '@maka/runtime/voice-service';
import type { ConnectionStore, SettingsStore } from '@maka/storage';

export interface VoiceIpcService {
  begin(input: VoiceBeginRequest): Promise<VoiceBeginResult>;
  finishCapture(operationId: unknown, input: unknown): Promise<VoiceFinishCaptureResult>;
  cancel(operationId: unknown): void;
  createRealtimeSession(offerSdp: unknown): Promise<VoiceRealtimeClientSession>;
  closeRealtimeSession(sessionId: unknown): void;
  validateCoordinatorToolCall(input: unknown): VoiceCoordinatorToolCall;
  consumeNativeAudioOperation: VoiceService['consumeNativeAudioOperation'];
}

export function createVoiceIpcService(deps: {
  settingsStore: SettingsStore;
  connectionStore: ConnectionStore;
  resolveConnectionSecret(slug: string): Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => number;
}): VoiceIpcService {
  const fetchImpl = deps.fetch ?? fetch;
  return createVoiceService({
    readSettings: () => deps.settingsStore.get().then((settings) => settings.voice),
    inspectConnection: async (slug) => {
      const connection = await deps.connectionStore.get(slug);
      if (!connection || !connection.enabled) return null;
      const secret = await deps.resolveConnectionSecret(slug).catch(() => null);
      return {
        connection,
        credentialReady:
          !providerAuthRequiresSecret(connection.providerType) || Boolean(secret),
      };
    },
    openConnection: async (slug) => {
      const connection = await deps.connectionStore.get(slug);
      if (!connection || !connection.enabled) {
        throw new Error('voice_connection_not_ready');
      }
      const secret = await deps.resolveConnectionSecret(slug);
      if (providerAuthRequiresSecret(connection.providerType) && !secret) {
        throw new Error('voice_connection_secret_missing');
      }
      const authorizationHeaders: Record<string, string> = {};
      if (secret) authorizationHeaders.Authorization = `Bearer ${secret}`;
      return {
        connection,
        fetch: fetchImpl,
        authorizationHeaders,
        close: () => undefined,
      };
    },
    ...(deps.now ? { now: deps.now } : {}),
  });
}

export function registerVoiceIpc(input: {
  ipcMain: IpcMain;
  service: VoiceIpcService;
}): void {
  input.ipcMain.handle('voice:begin', (_event, request) => input.service.begin(request));
  input.ipcMain.handle('voice:finishCapture', (_event, operationId, audio: VoiceCapturedAudio) =>
    input.service.finishCapture(operationId, audio),
  );
  input.ipcMain.handle('voice:cancel', (_event, operationId) => input.service.cancel(operationId));
  input.ipcMain.handle('voice:createRealtimeSession', (_event, offerSdp) =>
    input.service.createRealtimeSession(offerSdp),
  );
  input.ipcMain.handle('voice:closeRealtimeSession', (_event, sessionId) =>
    input.service.closeRealtimeSession(sessionId),
  );
  input.ipcMain.handle('voice:validateCoordinatorToolCall', (_event, call) =>
    input.service.validateCoordinatorToolCall(call),
  );
}
