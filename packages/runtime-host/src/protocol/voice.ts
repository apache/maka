import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_CAPTURE_DURATION_MS,
  VOICE_MAX_CHANNELS,
  VOICE_MAX_SAMPLE_RATE,
  type VoiceBeginRequest,
  type VoiceBeginResult,
  type VoiceCapturedAudio,
  type VoiceFinishCaptureResult,
  type VoiceModelRouteCapability,
  type VoiceRealtimeClientSession,
  type VoiceRoutePlan,
  type VoiceSettings,
} from '@maka/core/voice';
import {
  requireCount,
  requireExactRecord,
  requireId,
  requireRecord,
  requireShapedRecord,
  requireString,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const VOICE_PAYLOAD_CHUNK_MAX_BYTES = 48 * 1024;
const VOICE_CONNECTION_SLUG_MAX_LENGTH = 64;
const VOICE_MODEL_MAX_LENGTH = 256;
const VOICE_LANGUAGE_MAX_LENGTH = 32;
const VOICE_PROMPT_MAX_LENGTH = 1_000;
const VOICE_NAME_MAX_LENGTH = 64;
const VOICE_PROVIDER_LABEL_MAX_LENGTH = 256;
const VOICE_REALTIME_SDP_MAX_BYTES = 256 * 1024;
const BASE64_CHUNK_MAX_LENGTH = Math.ceil(VOICE_PAYLOAD_CHUNK_MAX_BYTES / 3) * 4;
const OPERATION_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'operation_conflict',
  'invalid_request',
  'internal_failure',
] as const;

export interface VoiceCaptureBeginInput {
  readonly request: VoiceBeginRequest;
  readonly settings: VoiceSettings;
}

export interface VoicePayloadAppendInput {
  readonly operationId: string;
  readonly offset: number;
  readonly chunk: string;
}

export interface VoicePayloadAppendResult {
  readonly receivedBytes: number;
}

export interface VoiceCaptureFinishInput {
  readonly operationId: string;
  readonly audio: Omit<VoiceCapturedAudio, 'bytes'>;
}

export interface VoiceOperationCancelInput {
  readonly operationId: string;
}

export interface VoiceOperationCancelResult {
  readonly cancelled: boolean;
}

export interface VoiceRealtimeBeginInput {
  readonly settings: VoiceSettings;
}

export interface VoiceRealtimeBeginResult {
  readonly operationId: string;
  readonly expiresAt: number;
}

export interface VoiceRealtimeFinishInput {
  readonly operationId: string;
}

export interface VoiceRealtimeCloseInput {
  readonly sessionId: string;
}

export interface VoiceRealtimeCloseResult {
  readonly closed: boolean;
}

export const VOICE_OPERATION_SPECS = {
  'voice.capture.begin': defineOperation<
    VoiceCaptureBeginInput,
    VoiceBeginResult,
    (typeof OPERATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: OPERATION_ERRORS,
    decodeInput: decodeCaptureBeginInput,
    decodeOutput: decodeVoiceBeginResult,
  }),
  'voice.payload.append': defineOperation<
    VoicePayloadAppendInput,
    VoicePayloadAppendResult,
    (typeof OPERATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: OPERATION_ERRORS,
    decodeInput: decodePayloadAppendInput,
    decodeOutput: decodePayloadAppendResult,
  }),
  'voice.capture.finish': defineOperation<
    VoiceCaptureFinishInput,
    VoiceFinishCaptureResult,
    (typeof OPERATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: OPERATION_ERRORS,
    decodeInput: decodeCaptureFinishInput,
    decodeOutput: decodeCaptureFinishResult,
  }),
  'voice.operation.cancel': defineOperation<
    VoiceOperationCancelInput,
    VoiceOperationCancelResult,
    (typeof OPERATION_ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: OPERATION_ERRORS,
    decodeInput: decodeOperationCancelInput,
    decodeOutput: decodeOperationCancelResult,
  }),
  'voice.realtime.begin': defineOperation<
    VoiceRealtimeBeginInput,
    VoiceRealtimeBeginResult,
    (typeof OPERATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: OPERATION_ERRORS,
    decodeInput: decodeRealtimeBeginInput,
    decodeOutput: decodeRealtimeBeginResult,
  }),
  'voice.realtime.finish': defineOperation<
    VoiceRealtimeFinishInput,
    VoiceRealtimeClientSession,
    (typeof OPERATION_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: OPERATION_ERRORS,
    decodeInput: decodeRealtimeFinishInput,
    decodeOutput: decodeRealtimeSession,
  }),
  'voice.realtime.close': defineOperation<
    VoiceRealtimeCloseInput,
    VoiceRealtimeCloseResult,
    (typeof OPERATION_ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: OPERATION_ERRORS,
    decodeInput: decodeRealtimeCloseInput,
    decodeOutput: decodeRealtimeCloseResult,
  }),
} as const;

function decodeCaptureBeginInput(value: unknown): VoiceCaptureBeginInput {
  const record = requireExactRecord(value, 'Voice capture begin input', ['request', 'settings']);
  return {
    request: decodeBeginRequest(record.request),
    settings: decodeVoiceSettings(record.settings),
  };
}

function decodeBeginRequest(value: unknown): VoiceBeginRequest {
  const record = requireShapedRecord(value, 'Voice begin request', ['intent'], ['currentAgent']);
  if (record.intent !== 'send_task' && record.intent !== 'dictate') {
    throw invalidProtocolFrame('Invalid Voice capture intent');
  }
  if (record.currentAgent === undefined) return { intent: record.intent };
  const currentAgent = requireExactRecord(record.currentAgent, 'Voice current agent', [
    'connectionSlug',
    'model',
  ]);
  return {
    intent: record.intent,
    currentAgent: {
      connectionSlug: requireString(
        currentAgent.connectionSlug,
        'Voice current agent connection',
        VOICE_CONNECTION_SLUG_MAX_LENGTH,
      ),
      model: requireString(currentAgent.model, 'Voice current agent model', VOICE_MODEL_MAX_LENGTH),
    },
  };
}

function decodeVoiceSettings(value: unknown): VoiceSettings {
  const record = requireExactRecord(value, 'Voice settings', ['recognition', 'realtime']);
  const recognition = requireExactRecord(record.recognition, 'Voice recognition settings', [
    'connectionSlug',
    'model',
    'language',
    'prompt',
  ]);
  const realtime = requireExactRecord(record.realtime, 'Voice realtime settings', [
    'connectionSlug',
    'model',
    'voice',
  ]);
  return {
    recognition: {
      connectionSlug: optionalString(
        recognition.connectionSlug,
        'Voice recognition connection',
        VOICE_CONNECTION_SLUG_MAX_LENGTH,
      ),
      model: optionalString(recognition.model, 'Voice recognition model', VOICE_MODEL_MAX_LENGTH),
      language: optionalString(
        recognition.language,
        'Voice recognition language',
        VOICE_LANGUAGE_MAX_LENGTH,
      ),
      prompt: optionalString(
        recognition.prompt,
        'Voice recognition prompt',
        VOICE_PROMPT_MAX_LENGTH,
      ),
    },
    realtime: {
      connectionSlug: optionalString(
        realtime.connectionSlug,
        'Voice realtime connection',
        VOICE_CONNECTION_SLUG_MAX_LENGTH,
      ),
      model: optionalString(realtime.model, 'Voice realtime model', VOICE_MODEL_MAX_LENGTH),
      voice: requireString(realtime.voice, 'Voice realtime voice', VOICE_NAME_MAX_LENGTH),
    },
  };
}

function decodePayloadAppendInput(value: unknown): VoicePayloadAppendInput {
  const record = requireExactRecord(value, 'Voice payload append input', [
    'operationId',
    'offset',
    'chunk',
  ]);
  const chunk = requireString(record.chunk, 'Voice payload chunk', BASE64_CHUNK_MAX_LENGTH);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk)) {
    throw invalidProtocolFrame('Invalid Voice payload encoding');
  }
  const decodedBytes = Buffer.from(chunk, 'base64').byteLength;
  if (decodedBytes === 0 || decodedBytes > VOICE_PAYLOAD_CHUNK_MAX_BYTES) {
    throw invalidProtocolFrame('Invalid Voice payload chunk size');
  }
  return {
    operationId: requireId(record.operationId, 'Voice operation ID'),
    offset: requireCount(record.offset, 'Voice payload offset'),
    chunk,
  };
}

function decodePayloadAppendResult(value: unknown): VoicePayloadAppendResult {
  const record = requireExactRecord(value, 'Voice payload append result', ['receivedBytes']);
  return { receivedBytes: requireCount(record.receivedBytes, 'Voice received bytes') };
}

function decodeCaptureFinishInput(value: unknown): VoiceCaptureFinishInput {
  const record = requireExactRecord(value, 'Voice capture finish input', ['operationId', 'audio']);
  const audio = requireExactRecord(record.audio, 'Voice capture metadata', [
    'mediaType',
    'format',
    'durationMs',
    'sampleRate',
    'channels',
  ]);
  if (
    audio.format !== 'wav' &&
    audio.format !== 'webm' &&
    audio.format !== 'mp3' &&
    audio.format !== 'm4a'
  ) {
    throw invalidProtocolFrame('Invalid Voice audio format');
  }
  const durationMs = finiteBoundedNumber(
    audio.durationMs,
    'Voice duration',
    VOICE_MAX_CAPTURE_DURATION_MS,
  );
  const sampleRate = finiteBoundedNumber(
    audio.sampleRate,
    'Voice sample rate',
    VOICE_MAX_SAMPLE_RATE,
  );
  const channels = finiteBoundedNumber(audio.channels, 'Voice channels', VOICE_MAX_CHANNELS);
  if (!Number.isInteger(channels)) throw invalidProtocolFrame('Invalid Voice channels');
  return {
    operationId: requireId(record.operationId, 'Voice operation ID'),
    audio: {
      mediaType: requireString(audio.mediaType, 'Voice media type', 128),
      format: audio.format,
      durationMs,
      sampleRate,
      channels,
    },
  };
}

function decodeCaptureFinishResult(value: unknown): VoiceFinishCaptureResult {
  const record = requireRecord(value, 'Voice capture finish result');
  if (record.kind === 'transcript') {
    const exact = requireExactRecord(record, 'Voice transcript result', [
      'kind',
      'operationId',
      'text',
      'providerLabel',
    ]);
    return {
      kind: 'transcript',
      operationId: requireId(exact.operationId, 'Voice operation ID'),
      text: requireUtf8String(exact.text, 'Voice transcript', 32 * 1024),
      providerLabel: requireString(
        exact.providerLabel,
        'Voice provider label',
        VOICE_PROVIDER_LABEL_MAX_LENGTH,
      ),
    };
  }
  const exact = requireExactRecord(record, 'Voice native audio result', [
    'kind',
    'operationId',
    'providerLabel',
  ]);
  if (exact.kind !== 'native_audio_ready') throw invalidProtocolFrame('Invalid Voice finish kind');
  return {
    kind: 'native_audio_ready',
    operationId: requireId(exact.operationId, 'Voice operation ID'),
    providerLabel: requireString(
      exact.providerLabel,
      'Voice provider label',
      VOICE_PROVIDER_LABEL_MAX_LENGTH,
    ),
  };
}

function decodeOperationCancelInput(value: unknown): VoiceOperationCancelInput {
  const record = requireExactRecord(value, 'Voice cancel input', ['operationId']);
  return { operationId: requireId(record.operationId, 'Voice operation ID') };
}

function decodeOperationCancelResult(value: unknown): VoiceOperationCancelResult {
  const record = requireExactRecord(value, 'Voice cancel result', ['cancelled']);
  if (typeof record.cancelled !== 'boolean')
    throw invalidProtocolFrame('Invalid Voice cancel result');
  return { cancelled: record.cancelled };
}

function decodeRealtimeBeginInput(value: unknown): VoiceRealtimeBeginInput {
  const record = requireExactRecord(value, 'Voice realtime begin input', ['settings']);
  return { settings: decodeVoiceSettings(record.settings) };
}

function decodeRealtimeBeginResult(value: unknown): VoiceRealtimeBeginResult {
  const record = requireExactRecord(value, 'Voice realtime begin result', [
    'operationId',
    'expiresAt',
  ]);
  return {
    operationId: requireId(record.operationId, 'Voice operation ID'),
    expiresAt: requireCount(record.expiresAt, 'Voice operation expiry'),
  };
}

function decodeRealtimeFinishInput(value: unknown): VoiceRealtimeFinishInput {
  const record = requireExactRecord(value, 'Voice realtime finish input', ['operationId']);
  return { operationId: requireId(record.operationId, 'Voice operation ID') };
}

function decodeRealtimeSession(value: unknown): VoiceRealtimeClientSession {
  const record = requireShapedRecord(
    value,
    'Voice realtime Session',
    ['sessionId', 'answerSdp', 'model', 'providerLabel'],
    ['expiresAt'],
  );
  return {
    sessionId: requireId(record.sessionId, 'Voice realtime Session ID'),
    answerSdp: requireUtf8String(
      record.answerSdp,
      'Voice answer SDP',
      VOICE_REALTIME_SDP_MAX_BYTES,
    ),
    model: requireString(record.model, 'Voice realtime model', VOICE_MODEL_MAX_LENGTH),
    providerLabel: requireString(
      record.providerLabel,
      'Voice provider label',
      VOICE_PROVIDER_LABEL_MAX_LENGTH,
    ),
    ...(record.expiresAt === undefined
      ? {}
      : { expiresAt: requireCount(record.expiresAt, 'Voice realtime expiry') }),
  };
}

function decodeRealtimeCloseInput(value: unknown): VoiceRealtimeCloseInput {
  const record = requireExactRecord(value, 'Voice realtime close input', ['sessionId']);
  return { sessionId: requireId(record.sessionId, 'Voice realtime Session ID') };
}

function decodeRealtimeCloseResult(value: unknown): VoiceRealtimeCloseResult {
  const record = requireExactRecord(value, 'Voice realtime close result', ['closed']);
  if (typeof record.closed !== 'boolean') throw invalidProtocolFrame('Invalid Voice close result');
  return { closed: record.closed };
}

function decodeVoiceBeginResult(value: unknown): VoiceBeginResult {
  const record = requireRecord(value, 'Voice begin result');
  if (record.ok === false) {
    const exact = requireExactRecord(record, 'Voice blocked result', ['ok', 'reason']);
    if (
      exact.reason !== 'recognition_not_configured' &&
      exact.reason !== 'realtime_not_configured' &&
      exact.reason !== 'model_not_ready' &&
      exact.reason !== 'adapter_unsupported' &&
      exact.reason !== 'permission_denied'
    ) {
      throw invalidProtocolFrame('Invalid Voice blocked reason');
    }
    return { ok: false, reason: exact.reason };
  }
  const exact = requireExactRecord(record, 'Voice ready result', [
    'ok',
    'operationId',
    'route',
    'expiresAt',
  ]);
  if (exact.ok !== true) throw invalidProtocolFrame('Invalid Voice begin result');
  return {
    ok: true,
    operationId: requireId(exact.operationId, 'Voice operation ID'),
    route: decodeVoiceRoute(exact.route),
    expiresAt: requireCount(exact.expiresAt, 'Voice operation expiry'),
  };
}

function decodeVoiceRoute(value: unknown): VoiceRoutePlan {
  const record = requireRecord(value, 'Voice route');
  if (record.kind === 'native_audio_task') {
    const exact = requireExactRecord(record, 'Voice native route', [
      'kind',
      'target',
      'transcriptProjection',
    ]);
    if (
      exact.transcriptProjection !== 'provider' &&
      exact.transcriptProjection !== 'configured_recognition' &&
      exact.transcriptProjection !== 'marker_only'
    ) {
      throw invalidProtocolFrame('Invalid Voice transcript projection');
    }
    return {
      kind: 'native_audio_task',
      target: decodeVoiceTarget(exact.target),
      transcriptProjection: exact.transcriptProjection,
    };
  }
  if (record.kind === 'transcription_to_draft') {
    const exact = requireExactRecord(record, 'Voice transcription route', ['kind', 'target']);
    return { kind: 'transcription_to_draft', target: decodeVoiceTarget(exact.target) };
  }
  if (record.kind === 'realtime_voice') {
    const exact = requireExactRecord(record, 'Voice realtime route', [
      'kind',
      'target',
      'transport',
    ]);
    if (exact.transport !== 'webrtc')
      throw invalidProtocolFrame('Invalid Voice realtime transport');
    return { kind: 'realtime_voice', target: decodeVoiceTarget(exact.target), transport: 'webrtc' };
  }
  throw invalidProtocolFrame('Invalid Voice route');
}

function decodeVoiceTarget(value: unknown): VoiceModelRouteCapability {
  const record = requireShapedRecord(
    value,
    'Voice route target',
    [
      'connectionSlug',
      'modelId',
      'modalities',
      'endpointRoles',
      'transports',
      'transcriptOutput',
      'adapterReady',
    ],
    ['providerLabel'],
  );
  const modalities = requireExactRecord(record.modalities, 'Voice modalities', ['input', 'output']);
  const input = stringEnumArray(
    modalities.input,
    ['text', 'image', 'audio'] as const,
    'Voice input modalities',
  );
  const output = stringEnumArray(
    modalities.output,
    ['text', 'image', 'audio'] as const,
    'Voice output modalities',
  );
  const endpointRoles = stringEnumArray(
    record.endpointRoles,
    ['agent_chat', 'audio_chat', 'transcription', 'realtime_voice', 'speech_generation'] as const,
    'Voice endpoint roles',
  );
  const transports = stringEnumArray(
    record.transports,
    [
      'openai_chat_audio',
      'openai_audio_transcriptions',
      'openai_realtime',
      'provider_native',
    ] as const,
    'Voice transports',
  );
  if (typeof record.transcriptOutput !== 'boolean' || typeof record.adapterReady !== 'boolean') {
    throw invalidProtocolFrame('Invalid Voice route readiness');
  }
  return {
    connectionSlug: requireString(
      record.connectionSlug,
      'Voice route connection',
      VOICE_CONNECTION_SLUG_MAX_LENGTH,
    ),
    modelId: requireString(record.modelId, 'Voice route model', VOICE_MODEL_MAX_LENGTH),
    ...(record.providerLabel === undefined
      ? {}
      : {
          providerLabel: requireString(
            record.providerLabel,
            'Voice provider label',
            VOICE_PROVIDER_LABEL_MAX_LENGTH,
          ),
        }),
    modalities: { input, output },
    endpointRoles,
    transports,
    transcriptOutput: record.transcriptOutput,
    adapterReady: record.adapterReady,
  };
}

function optionalString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function finiteBoundedNumber(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function stringEnumArray<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): Array<T[number]> {
  if (!Array.isArray(value) || value.length > allowed.length) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  const allowedValues = new Set<string>(allowed);
  if (value.some((entry) => typeof entry !== 'string' || !allowedValues.has(entry))) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return [...value] as Array<T[number]>;
}
