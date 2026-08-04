import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import {
  PROVIDER_DEFAULTS,
  connectionEnabledModelIds,
  effectiveBaseUrl,
  normalizeVoiceCoordinatorToolCall,
  normalizeVoiceTranscriptText,
  resolveModelVoiceMetadata,
  resolveVoiceRoute,
  validateVoiceCaptureRequest,
  type EphemeralVoiceAudio,
  type LlmConnection,
  type VoiceBeginRequest,
  type VoiceBeginResult,
  type VoiceCapturedAudio,
  type VoiceCoordinatorToolCall,
  type VoiceFinishCaptureResult,
  type VoiceModelRouteCapability,
  type VoiceRealtimeClientSession,
  type VoiceRoutePlan,
} from '@maka/core';
import { providerAuthRequiresSecret } from '@maka/core/llm-connections';
import type { ConnectionStore, SettingsStore } from '@maka/storage';

const OPERATION_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_OPERATIONS = 32;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const TRANSCRIPTION_TIMEOUT_MS = 90_000;
const REALTIME_TOKEN_TIMEOUT_MS = 20_000;
const REALTIME_CONNECT_TIMEOUT_MS = 30_000;
const MAX_REALTIME_SDP_BYTES = 256 * 1024;
const AUDIO_MIME_TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
]);

interface VoiceOperation {
  id: string;
  createdAt: number;
  expiresAt: number;
  route: Exclude<VoiceRoutePlan, { kind: 'blocked' | 'realtime_voice' }>;
  recognitionOptions: {
    language: string;
    prompt: string;
  };
  abortController: AbortController;
  audio?: EphemeralVoiceAudio;
}

export interface VoiceIpcService {
  begin(input: VoiceBeginRequest): Promise<VoiceBeginResult>;
  finishCapture(operationId: unknown, input: unknown): Promise<VoiceFinishCaptureResult>;
  cancel(operationId: unknown): void;
  createRealtimeSession(offerSdp: unknown): Promise<VoiceRealtimeClientSession>;
  closeRealtimeSession(sessionId: unknown): void;
  validateCoordinatorToolCall(input: unknown): VoiceCoordinatorToolCall;
  consumeNativeAudioOperation(input: {
    operationId: string;
    connectionSlug: string;
    model: string;
  }): EphemeralVoiceAudio;
}

export function createVoiceIpcService(deps: {
  settingsStore: SettingsStore;
  connectionStore: ConnectionStore;
  resolveConnectionSecret(slug: string): Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => number;
}): VoiceIpcService {
  const operations = new Map<string, VoiceOperation>();
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let realtimeSessionPending = false;
  let activeRealtimeLease: { sessionId: string; expiresAt: number } | undefined;

  async function begin(input: VoiceBeginRequest): Promise<VoiceBeginResult> {
    sweepExpired();
    const resolved = await resolveConfiguredRoute(normalizeBeginRequest(input));
    if (resolved.plan.kind === 'blocked') {
      return { ok: false, reason: resolved.plan.reason };
    }
    if (resolved.plan.kind === 'realtime_voice') {
      return { ok: false, reason: 'adapter_unsupported' };
    }
    if (operations.size >= MAX_ACTIVE_OPERATIONS) {
      const oldest = operations.keys().next().value as string | undefined;
      if (oldest) {
        operations.get(oldest)?.abortController.abort();
        operations.delete(oldest);
      }
    }
    const operationId = randomUUID();
    const expiresAt = now() + OPERATION_TTL_MS;
    operations.set(operationId, {
      id: operationId,
      createdAt: now(),
      expiresAt,
      route: resolved.plan,
      recognitionOptions: resolved.recognitionOptions,
      abortController: new AbortController(),
    });
    return { ok: true, operationId, route: resolved.plan, expiresAt };
  }

  async function finishCapture(
    operationIdInput: unknown,
    input: unknown,
  ): Promise<VoiceFinishCaptureResult> {
    sweepExpired();
    const operationId = normalizeOperationId(operationIdInput);
    const operation = operations.get(operationId);
    if (!operation) throw new Error('voice_operation_expired');
    if (operation.audio) throw new Error('voice_operation_already_staged');
    const audio = normalizeCapturedAudio(input);

    if (operation.route.kind === 'native_audio_task') {
      operation.audio = audio;
      return {
        kind: 'native_audio_ready',
        operationId,
        providerLabel:
          operation.route.target.providerLabel ?? operation.route.target.connectionSlug,
      };
    }

    try {
      const text = await transcribe(
        operation.route.target,
        audio,
        operation.recognitionOptions,
        operation.abortController.signal,
      );
      return {
        kind: 'transcript',
        operationId,
        text,
        providerLabel:
          operation.route.target.providerLabel ?? operation.route.target.connectionSlug,
      };
    } finally {
      if (operations.get(operationId) === operation) operations.delete(operationId);
    }
  }

  function cancel(operationIdInput: unknown): void {
    const operationId = normalizeOperationId(operationIdInput);
    operations.get(operationId)?.abortController.abort();
    operations.delete(operationId);
  }

  function consumeNativeAudioOperation(input: {
    operationId: string;
    connectionSlug: string;
    model: string;
  }): EphemeralVoiceAudio {
    sweepExpired();
    const operationId = normalizeOperationId(input.operationId);
    const operation = operations.get(operationId);
    if (!operation || operation.route.kind !== 'native_audio_task' || !operation.audio) {
      throw new Error('voice_operation_not_ready');
    }
    if (
      operation.route.target.connectionSlug !== input.connectionSlug ||
      operation.route.target.modelId !== input.model
    ) {
      throw new Error('voice_operation_target_changed');
    }
    operations.delete(operationId);
    return operation.audio;
  }

  async function createRealtimeSession(offerSdpInput: unknown): Promise<VoiceRealtimeClientSession> {
    if (realtimeSessionPending || (activeRealtimeLease && activeRealtimeLease.expiresAt > now())) {
      throw new Error('voice_realtime_session_already_active');
    }
    activeRealtimeLease = undefined;
    const offerSdp = normalizeRealtimeOfferSdp(offerSdpInput);
    const sessionId = randomUUID();
    realtimeSessionPending = true;
    try {
      const { plan } = await resolveConfiguredRoute({ intent: 'voice_chat' });
      if (plan.kind === 'blocked') throw new Error(`voice_route_blocked:${plan.reason}`);
      if (plan.kind !== 'realtime_voice') throw new Error('voice_realtime_not_ready');
      const connection = await requireConnection(plan.target.connectionSlug);
      const secret = await deps.resolveConnectionSecret(connection.slug);
      if (providerAuthRequiresSecret(connection.providerType) && !secret) {
        throw new Error('voice_connection_secret_missing');
      }
      const baseUrl = effectiveBaseUrl(connection);
      const tokenUrl = endpointUrl(baseUrl, 'realtime/client_secrets');
      const endpoint = endpointUrl(baseUrl, 'realtime/calls');
      const tokenResponse = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: requestHeaders(secret),
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model: plan.target.modelId,
            instructions:
              'You are Maka Voice Coordinator. Keep responses concise. Use only the four coordination tools for work; never claim a task changed unless the tool output confirms it.',
            audio: {
              output: {
                voice: (await deps.settingsStore.get()).voice.realtime.voice,
              },
            },
            tools: realtimeCoordinatorTools(),
            tool_choice: 'auto',
          },
        }),
        signal: AbortSignal.timeout(REALTIME_TOKEN_TIMEOUT_MS),
      });
      const payload = parseJsonObject(await readBoundedResponse(tokenResponse));
      if (!tokenResponse.ok) {
        throw providerHttpError('realtime_session', tokenResponse.status);
      }
      const nested =
        payload.client_secret && typeof payload.client_secret === 'object'
          ? (payload.client_secret as Record<string, unknown>)
          : {};
      const clientSecret =
        typeof payload.value === 'string'
          ? payload.value
          : typeof nested.value === 'string'
            ? nested.value
            : '';
      if (!clientSecret) throw new Error('voice_realtime_secret_missing');
      const expiresAtRaw = payload.expires_at ?? nested.expires_at;
      const expiresAt =
        typeof expiresAtRaw === 'number' ? expiresAtRaw * 1_000 : now() + 60_000;
      const callResponse = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp',
          'OpenAI-Beta': 'realtime=v1',
        },
        body: offerSdp,
        signal: AbortSignal.timeout(REALTIME_CONNECT_TIMEOUT_MS),
      });
      const answerSdp = await readBoundedResponse(callResponse);
      if (!callResponse.ok) {
        throw providerHttpError('realtime_connect', callResponse.status);
      }
      if (!answerSdp.trim()) throw new Error('voice_realtime_answer_invalid');
      activeRealtimeLease = { sessionId, expiresAt: now() + 24 * 60 * 60_000 };
      return {
        sessionId,
        answerSdp,
        model: plan.target.modelId,
        providerLabel: plan.target.providerLabel ?? plan.target.connectionSlug,
        expiresAt,
      };
    } finally {
      realtimeSessionPending = false;
    }
  }

  function closeRealtimeSession(sessionIdInput: unknown): void {
    const sessionId = normalizeOperationId(sessionIdInput);
    if (activeRealtimeLease?.sessionId === sessionId) activeRealtimeLease = undefined;
  }

  async function resolveConfiguredRoute(input: VoiceBeginRequest): Promise<{
    plan: VoiceRoutePlan;
    recognitionOptions: { language: string; prompt: string };
  }> {
    const settings = await deps.settingsStore.get();
    const recognition = await configuredCapability(
      settings.voice.recognition.connectionSlug,
      settings.voice.recognition.model,
      'transcription',
    );
    const realtime = await configuredCapability(
      settings.voice.realtime.connectionSlug,
      settings.voice.realtime.model,
      'realtime_voice',
    );
    const currentAgent = input.currentAgent
      ? await configuredCapability(
          input.currentAgent.connectionSlug,
          input.currentAgent.model,
          'current_agent',
        )
      : undefined;
    return {
      plan: resolveVoiceRoute({
        intent: input.intent,
        ...(currentAgent ? { currentAgent } : {}),
        ...(recognition ? { recognition } : {}),
        ...(realtime ? { realtime } : {}),
      }),
      recognitionOptions: {
        language: settings.voice.recognition.language,
        prompt: settings.voice.recognition.prompt,
      },
    };
  }

  async function configuredCapability(
    connectionSlug: string,
    model: string,
    roleHint: 'transcription' | 'realtime_voice' | 'current_agent',
  ): Promise<VoiceModelRouteCapability | undefined> {
    if (!connectionSlug || !model) return undefined;
    const connection = await deps.connectionStore.get(connectionSlug);
    if (!connection || !connection.enabled || !configuredModelExists(connection, model)) {
      return undefined;
    }
    const metadata = resolveModelVoiceMetadata(connection.providerType, connection.models, model);
    const adapterKind = PROVIDER_DEFAULTS[connection.providerType]?.runtimeAdapter.kind;
    const openAiWire = adapterKind === 'openai' || adapterKind === 'openai-compatible';
    const secret = await deps.resolveConnectionSecret(connection.slug).catch(() => null);
    const credentialReady =
      !providerAuthRequiresSecret(connection.providerType) || Boolean(secret);

    const endpointRoles = [...(metadata.endpointRoles ?? [])];
    const transports = [...(metadata.transports ?? [])];
    let modalities = metadata.modalities ?? { input: ['text' as const], output: ['text' as const] };
    if (roleHint === 'transcription') {
      if (!endpointRoles.includes('transcription')) endpointRoles.push('transcription');
      if (!transports.includes('openai_audio_transcriptions')) {
        transports.push('openai_audio_transcriptions');
      }
      modalities = { input: ['audio'], output: ['text'] };
    } else if (roleHint === 'realtime_voice') {
      if (!endpointRoles.includes('realtime_voice')) endpointRoles.push('realtime_voice');
      if (!transports.includes('openai_realtime')) transports.push('openai_realtime');
      modalities = { input: ['text', 'audio'], output: ['text', 'audio'] };
    }
    return {
      connectionSlug,
      modelId: model,
      providerLabel: connection.name,
      modalities,
      endpointRoles,
      transports,
      transcriptOutput: metadata.transcriptOutput === true,
      adapterReady: openAiWire && credentialReady,
    };
  }

  async function transcribe(
    target: VoiceModelRouteCapability,
    audio: EphemeralVoiceAudio,
    options: { language: string; prompt: string },
    abortSignal: AbortSignal,
  ): Promise<string> {
    const connection = await requireConnection(target.connectionSlug);
    const secret = await deps.resolveConnectionSecret(connection.slug);
    if (providerAuthRequiresSecret(connection.providerType) && !secret) {
      throw new Error('voice_connection_secret_missing');
    }
    const form = new FormData();
    form.set(
      'file',
      new Blob([Uint8Array.from(audio.bytes)], { type: audio.mediaType }),
      `voice-input.${audio.format}`,
    );
    form.set('model', target.modelId);
    form.set('response_format', 'json');
    if (options.language) form.set('language', options.language);
    if (options.prompt) form.set('prompt', options.prompt);
    const response = await fetchImpl(endpointUrl(effectiveBaseUrl(connection), 'audio/transcriptions'), {
      method: 'POST',
      headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
      body: form,
      signal: AbortSignal.any([
        abortSignal,
        AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      ]),
    });
    const body = await readBoundedResponse(response);
    if (!response.ok) throw providerHttpError('transcription', response.status);
    let rawText = '';
    try {
      const value = JSON.parse(body) as { text?: unknown };
      rawText = typeof value.text === 'string' ? value.text : '';
    } catch {
      rawText = body;
    }
    const normalized = normalizeVoiceTranscriptText(rawText);
    if (!normalized.ok) throw new Error(`voice_transcript_invalid:${normalized.reason}`);
    return normalized.value;
  }

  async function requireConnection(slug: string): Promise<LlmConnection> {
    const connection = await deps.connectionStore.get(slug);
    if (!connection || !connection.enabled) throw new Error('voice_connection_not_ready');
    return connection;
  }

  function sweepExpired(): void {
    const current = now();
    for (const [id, operation] of operations) {
      if (operation.expiresAt <= current) {
        operation.abortController.abort();
        operations.delete(id);
      }
    }
  }

  return {
    begin,
    finishCapture,
    cancel,
    createRealtimeSession,
    closeRealtimeSession,
    validateCoordinatorToolCall: normalizeVoiceCoordinatorToolCall,
    consumeNativeAudioOperation,
  };
}

export function registerVoiceIpc(input: {
  ipcMain: IpcMain;
  service: VoiceIpcService;
}): void {
  input.ipcMain.handle('voice:begin', (_event, request) => input.service.begin(request));
  input.ipcMain.handle('voice:finishCapture', (_event, operationId, audio) =>
    input.service.finishCapture(operationId, audio),
  );
  input.ipcMain.handle('voice:cancel', (_event, operationId) =>
    input.service.cancel(operationId),
  );
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

function configuredModelExists(connection: LlmConnection, model: string): boolean {
  return (
    connectionEnabledModelIds(connection).includes(model) ||
    connection.models?.some((entry) => entry.id === model) === true
  );
}

function normalizeRealtimeOfferSdp(input: unknown): string {
  if (typeof input !== 'string') throw new Error('voice_realtime_offer_invalid');
  const offerSdp = input.trim();
  if (
    !offerSdp.startsWith('v=0') ||
    new TextEncoder().encode(offerSdp).byteLength > MAX_REALTIME_SDP_BYTES
  ) {
    throw new Error('voice_realtime_offer_invalid');
  }
  return offerSdp;
}

function normalizeBeginRequest(input: unknown): VoiceBeginRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('voice_begin_invalid');
  }
  const value = input as { intent?: unknown; currentAgent?: unknown };
  if (
    value.intent !== 'send_task' &&
    value.intent !== 'dictate' &&
    value.intent !== 'voice_chat'
  ) {
    throw new Error('voice_begin_invalid');
  }
  if (value.currentAgent === undefined) return { intent: value.intent };
  if (
    !value.currentAgent ||
    typeof value.currentAgent !== 'object' ||
    Array.isArray(value.currentAgent)
  ) {
    throw new Error('voice_begin_invalid');
  }
  const currentAgent = value.currentAgent as {
    connectionSlug?: unknown;
    model?: unknown;
  };
  if (
    typeof currentAgent.connectionSlug !== 'string' ||
    currentAgent.connectionSlug.length === 0 ||
    currentAgent.connectionSlug.length > 64 ||
    typeof currentAgent.model !== 'string' ||
    currentAgent.model.length === 0 ||
    currentAgent.model.length > 256
  ) {
    throw new Error('voice_begin_invalid');
  }
  return {
    intent: value.intent,
    currentAgent: {
      connectionSlug: currentAgent.connectionSlug,
      model: currentAgent.model,
    },
  };
}

function normalizeCapturedAudio(input: unknown): EphemeralVoiceAudio {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('voice_audio_invalid');
  }
  const value = input as Partial<VoiceCapturedAudio>;
  const bytes =
    value.bytes instanceof Uint8Array
      ? new Uint8Array(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength)
      : undefined;
  if (!bytes || !AUDIO_MIME_TYPES.has(value.mediaType ?? '')) {
    throw new Error('voice_audio_invalid');
  }
  if (
    value.format !== 'wav' &&
    value.format !== 'webm' &&
    value.format !== 'mp3' &&
    value.format !== 'm4a'
  ) {
    throw new Error('voice_audio_invalid');
  }
  const validated = validateVoiceCaptureRequest({
    mode: 'push_to_talk',
    permission: 'granted',
    durationMs: value.durationMs,
    audioBytes: bytes.byteLength,
    sampleRate: value.sampleRate,
    channels: value.channels,
  });
  if (!validated.ok) throw new Error(`voice_audio_invalid:${validated.reason}`);
  return {
    bytes,
    mediaType: value.mediaType!,
    format: value.format,
    durationMs: value.durationMs!,
    sampleRate: value.sampleRate!,
    channels: value.channels!,
    retention: 'operation_memory',
  };
}

function normalizeOperationId(input: unknown): string {
  if (
    typeof input !== 'string' ||
    input.length > 64 ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(input)
  ) {
    throw new Error('voice_operation_invalid');
  }
  return input;
}

function endpointUrl(baseUrl: string, suffix: string): string {
  if (!baseUrl) throw new Error('voice_connection_base_url_missing');
  return new URL(suffix, `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

function requestHeaders(secret: string | null): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'realtime=v1',
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
  };
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error('voice_provider_response_too_large');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error('voice_provider_response_too_large');
  }
  return new TextDecoder().decode(bytes);
}

function parseJsonObject(input: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('voice_provider_response_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('voice_provider_response_invalid');
  }
  return parsed as Record<string, unknown>;
}

function providerHttpError(stage: string, status: number): Error {
  if (status === 401 || status === 403) return new Error(`voice_${stage}_auth`);
  if (status === 404) return new Error(`voice_${stage}_unsupported`);
  if (status === 413) return new Error(`voice_${stage}_too_large`);
  if (status === 429) return new Error(`voice_${stage}_rate_limited`);
  if (status >= 500) return new Error(`voice_${stage}_unavailable`);
  return new Error(`voice_${stage}_failed`);
}

function realtimeCoordinatorTools(): Array<Record<string, unknown>> {
  return [
    {
      type: 'function',
      name: 'start_task',
      description: 'Start a concrete Maka agent task.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { task: { type: 'string' } },
        required: ['task'],
      },
    },
    {
      type: 'function',
      name: 'steer_task',
      description: 'Add guidance to the currently running Maka task.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { guidance: { type: 'string' } },
        required: ['guidance'],
      },
    },
    {
      type: 'function',
      name: 'check_task',
      description: 'Check the status of the active Maka task.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      type: 'function',
      name: 'summarize_task',
      description: 'Summarize the latest durable output of the active Maka task.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
  ];
}
