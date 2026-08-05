import { randomUUID } from 'node:crypto';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import {
  VOICE_MAX_AUDIO_BYTES,
  type EphemeralVoiceAudio,
  type VoiceCapturedAudio,
} from '@maka/core/voice';
import type { ConnectionCatalogEntry } from '@maka/core/runtime-policy';
import { createProxiedFetchTransport } from '@maka/runtime';
import {
  createVoiceService,
  type VoiceConnection,
  type VoiceService,
} from '@maka/runtime/voice-service';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import {
  VOICE_PAYLOAD_CHUNK_MAX_BYTES,
  type OperationOutcome,
  type VoiceCaptureBeginInput,
  type VoiceCaptureFinishInput,
  type VoiceOperationCancelInput,
  type VoicePayloadAppendInput,
  type VoiceRealtimeBeginInput,
  type VoiceRealtimeCloseInput,
  type VoiceRealtimeFinishInput,
} from '../protocol/index.js';
import type { ConnectionContext, VoiceOperationHandlerMap } from './operation-dispatcher.js';
import type { HostOAuthExecutionAuthority } from './oauth-execution-authority.js';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';

const OPERATION_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_PAYLOADS = 32;
const MAX_REALTIME_SDP_BYTES = 256 * 1024;

interface PayloadBase {
  readonly operationId: string;
  readonly ownerConnectionId: string;
  readonly expiresAt: number;
}

interface CapturePayload extends PayloadBase {
  readonly kind: 'capture';
  readonly chunks: Uint8Array[];
  receivedBytes: number;
}

interface RealtimePayload extends PayloadBase {
  readonly kind: 'realtime';
  readonly settings: VoiceRealtimeBeginInput['settings'];
  readonly chunks: Uint8Array[];
  receivedBytes: number;
}

interface NativeAudioPayload extends PayloadBase {
  readonly kind: 'native_audio_ready';
}

type VoicePayload = CapturePayload | RealtimePayload | NativeAudioPayload;

export class HostVoiceCoordinator {
  readonly handlers: VoiceOperationHandlerMap = {
    'voice.capture.begin': (input, context) => this.#beginCapture(input, context),
    'voice.payload.append': (input, context) => this.#appendPayload(input, context),
    'voice.capture.finish': (input, context) => this.#finishCapture(input, context),
    'voice.operation.cancel': (input, context) => this.#cancel(input, context),
    'voice.realtime.begin': (input, context) => this.#beginRealtime(input, context),
    'voice.realtime.finish': (input, context) => this.#finishRealtime(input, context),
    'voice.realtime.close': (input, context) => this.#closeRealtime(input, context),
  };

  readonly #voice: VoiceService;
  readonly #payloads = new Map<string, VoicePayload>();
  readonly #realtimeOwners = new Map<string, string>();
  readonly #now: () => number;

  constructor(input: {
    readonly runtimePolicy: RuntimePolicyStoresWriter;
    readonly oauthCredentials: HostOAuthExecutionAuthority;
    readonly now?: () => number;
    readonly voice?: VoiceService;
  }) {
    this.#now = input.now ?? Date.now;
    this.#voice =
      input.voice ??
      createVoiceService({
        readSettings: async () => {
          throw new Error('Runtime Host Voice settings must be supplied by the client');
        },
        inspectConnection: async (slug) => {
          const resolved = await input.runtimePolicy.operations.resolveExecutionConnection(slug);
          if (resolved.kind !== 'ready') return null;
          return { connection: toVoiceConnection(resolved.connection), credentialReady: true };
        },
        openConnection: async (slug) => {
          const resolved = await input.runtimePolicy.operations.resolveExecutionConnection(slug);
          if (resolved.kind !== 'ready') throw new Error('voice_connection_not_ready');
          const connection = toVoiceConnection(resolved.connection);
          const proxy = toRuntimePolicyProxy(
            resolved.networkProxy,
            resolved.secretMaterial.networkProxy?.secret,
          );
          const transport = createProxiedFetchTransport(proxy);
          try {
            const provider = PROVIDER_DEFAULTS[connection.providerType];
            let secret = resolved.secretMaterial.connection?.secret ?? '';
            if (provider?.authKind === 'oauth_token') {
              const material = resolved.secretMaterial.connection;
              if (!material) throw new Error('voice_connection_secret_missing');
              const binding = input.oauthCredentials.bind({
                providerType: connection.providerType,
                connectionSlug: connection.slug,
                material,
                createRefreshTransport: () => createProxiedFetchTransport(proxy),
              });
              secret = (await binding.resolve()).access_token;
            }
            const authorizationHeaders: Record<string, string> = {};
            if (secret) authorizationHeaders.Authorization = `Bearer ${secret}`;
            return {
              connection,
              fetch: transport.fetch,
              authorizationHeaders,
              close: () => transport.close(),
            };
          } catch (error) {
            await transport.close();
            throw error;
          }
        },
        now: this.#now,
      });
  }

  consumeNativeAudio(input: {
    readonly operationId: string;
    readonly connectionSlug: string;
    readonly model: string;
    readonly ownerConnectionId: string;
  }): EphemeralVoiceAudio {
    this.#sweepExpired();
    const payload = this.#payloads.get(input.operationId);
    if (
      payload?.kind !== 'native_audio_ready' ||
      payload.ownerConnectionId !== input.ownerConnectionId
    ) {
      throw new Error('voice_operation_not_ready');
    }
    const audio = this.#voice.consumeNativeAudioOperation(input);
    this.#payloads.delete(input.operationId);
    return audio;
  }

  async #beginCapture(
    input: VoiceCaptureBeginInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'voice.capture.begin'>> {
    this.#sweepExpired();
    try {
      const result = await this.#voice.begin(input.request, input.settings);
      if (result.ok) {
        this.#makeRoom();
        this.#payloads.set(result.operationId, {
          kind: 'capture',
          operationId: result.operationId,
          ownerConnectionId: context.connectionId,
          expiresAt: result.expiresAt,
          chunks: [],
          receivedBytes: 0,
        });
      }
      return { ok: true, result };
    } catch {
      return internalFailure('Voice capture could not start');
    }
  }

  async #appendPayload(
    input: VoicePayloadAppendInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'voice.payload.append'>> {
    this.#sweepExpired();
    const payload = this.#payloads.get(input.operationId);
    if (!payload) return notFound('Voice operation does not exist');
    if (payload.ownerConnectionId !== context.connectionId) {
      return operationConflict('Voice operation belongs to a different client connection');
    }
    if (payload.kind === 'native_audio_ready') {
      return operationConflict('Voice capture is already complete');
    }
    if (payload.receivedBytes !== input.offset) {
      return operationConflict('Voice payload offset does not match the accepted prefix');
    }
    const chunk = Uint8Array.from(Buffer.from(input.chunk, 'base64'));
    if (chunk.byteLength === 0 || chunk.byteLength > VOICE_PAYLOAD_CHUNK_MAX_BYTES) {
      return invalidRequest('Voice payload chunk is invalid');
    }
    const limit = payload.kind === 'capture' ? VOICE_MAX_AUDIO_BYTES : MAX_REALTIME_SDP_BYTES;
    if (payload.receivedBytes + chunk.byteLength > limit) {
      return invalidRequest('Voice payload exceeds its size limit');
    }
    payload.chunks.push(chunk);
    payload.receivedBytes += chunk.byteLength;
    return { ok: true, result: { receivedBytes: payload.receivedBytes } };
  }

  async #finishCapture(
    input: VoiceCaptureFinishInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'voice.capture.finish'>> {
    this.#sweepExpired();
    const payload = this.#payloads.get(input.operationId);
    if (!payload) return notFound('Voice operation does not exist');
    if (payload.ownerConnectionId !== context.connectionId) {
      return operationConflict('Voice operation belongs to a different client connection');
    }
    if (payload.kind !== 'capture') {
      return operationConflict('Voice operation is not an active capture');
    }
    if (payload.receivedBytes === 0) return invalidRequest('Voice capture is empty');
    const audio: VoiceCapturedAudio = {
      ...input.audio,
      bytes: concatenate(payload.chunks, payload.receivedBytes),
    };
    try {
      const result = await this.#voice.finishCapture(input.operationId, audio);
      if (result.kind === 'native_audio_ready') {
        this.#payloads.set(input.operationId, {
          kind: 'native_audio_ready',
          operationId: input.operationId,
          ownerConnectionId: context.connectionId,
          expiresAt: payload.expiresAt,
        });
      } else {
        this.#payloads.delete(input.operationId);
      }
      return { ok: true, result };
    } catch {
      this.#payloads.delete(input.operationId);
      return internalFailure('Voice capture could not finish');
    }
  }

  async #cancel(
    input: VoiceOperationCancelInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'voice.operation.cancel'>> {
    this.#sweepExpired();
    const payload = this.#payloads.get(input.operationId);
    if (!payload) return { ok: true, result: { cancelled: false } };
    if (payload.ownerConnectionId !== context.connectionId) {
      return operationConflict('Voice operation belongs to a different client connection');
    }
    this.#voice.cancel(input.operationId);
    this.#payloads.delete(input.operationId);
    return { ok: true, result: { cancelled: true } };
  }

  async #beginRealtime(
    input: VoiceRealtimeBeginInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'voice.realtime.begin'>> {
    this.#sweepExpired();
    this.#makeRoom();
    const operationId = randomUUID();
    const expiresAt = this.#now() + OPERATION_TTL_MS;
    this.#payloads.set(operationId, {
      kind: 'realtime',
      operationId,
      ownerConnectionId: context.connectionId,
      expiresAt,
      settings: input.settings,
      chunks: [],
      receivedBytes: 0,
    });
    return { ok: true, result: { operationId, expiresAt } };
  }

  async #finishRealtime(
    input: VoiceRealtimeFinishInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'voice.realtime.finish'>> {
    this.#sweepExpired();
    const payload = this.#payloads.get(input.operationId);
    if (!payload) return notFound('Voice operation does not exist');
    if (payload.ownerConnectionId !== context.connectionId) {
      return operationConflict('Voice operation belongs to a different client connection');
    }
    if (payload.kind !== 'realtime') {
      return operationConflict('Voice operation is not a realtime offer');
    }
    if (payload.receivedBytes === 0) return invalidRequest('Voice realtime offer is empty');
    let offerSdp: string;
    try {
      offerSdp = new TextDecoder('utf-8', { fatal: true }).decode(
        concatenate(payload.chunks, payload.receivedBytes),
      );
    } catch {
      this.#payloads.delete(input.operationId);
      return invalidRequest('Voice realtime offer is not valid UTF-8');
    }
    this.#payloads.delete(input.operationId);
    try {
      const result = await this.#voice.createRealtimeSession(offerSdp, payload.settings);
      this.#realtimeOwners.set(result.sessionId, context.connectionId);
      return { ok: true, result };
    } catch (error) {
      if (isErrorWithMessage(error, 'voice_realtime_offer_invalid')) {
        return invalidRequest('Voice realtime offer is invalid');
      }
      return internalFailure('Voice realtime Session could not start');
    }
  }

  async #closeRealtime(
    input: VoiceRealtimeCloseInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'voice.realtime.close'>> {
    const owner = this.#realtimeOwners.get(input.sessionId);
    if (!owner) return { ok: true, result: { closed: false } };
    if (owner !== context.connectionId) {
      return operationConflict('Voice realtime Session belongs to a different client connection');
    }
    this.#voice.closeRealtimeSession(input.sessionId);
    this.#realtimeOwners.delete(input.sessionId);
    return { ok: true, result: { closed: true } };
  }

  #makeRoom(): void {
    if (this.#payloads.size < MAX_ACTIVE_PAYLOADS) return;
    const oldest = this.#payloads.keys().next().value as string | undefined;
    if (!oldest) return;
    this.#voice.cancel(oldest);
    this.#payloads.delete(oldest);
  }

  #sweepExpired(): void {
    const current = this.#now();
    for (const [operationId, payload] of this.#payloads) {
      if (payload.expiresAt > current) continue;
      this.#voice.cancel(operationId);
      this.#payloads.delete(operationId);
    }
  }
}

function toVoiceConnection(connection: ConnectionCatalogEntry): VoiceConnection {
  return {
    slug: connection.slug,
    name: connection.name,
    providerType: connection.providerType,
    ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
    enabled: connection.enabled,
    enabledModelIds: [...connection.enabledModelIds],
    models: [...connection.models],
  };
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function notFound(message: string) {
  return { ok: false as const, error: { code: 'not_found' as const, message } };
}

function operationConflict(message: string) {
  return { ok: false as const, error: { code: 'operation_conflict' as const, message } };
}

function invalidRequest(message: string) {
  return { ok: false as const, error: { code: 'invalid_request' as const, message } };
}

function internalFailure(message: string) {
  return { ok: false as const, error: { code: 'internal_failure' as const, message } };
}

function isErrorWithMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message;
}
