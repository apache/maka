export const VOICE_MAX_TRANSCRIPT_CHARS = 8_000;
export const VOICE_MAX_CAPTURE_DURATION_MS = 60_000;
export const VOICE_MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const VOICE_MAX_SAMPLE_RATE = 48_000;
export const VOICE_MAX_CHANNELS = 1;
export const VOICE_TTS_MAX_TEXT_CHARS = 4_000;
export const VOICE_INPUT_MARKER = '[Voice input]';

const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F-\u009F]/g;
const WHITESPACE_REGEX = /\s+/g;

export type VoicePermissionStatus =
  | 'unknown'
  | 'not_determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unsupported';

export type VoiceInputMode = 'off' | 'push_to_talk' | 'toggle_to_record';

export type VoiceSttProvider = 'disabled' | 'local' | 'cloud';

export type VoiceTtsProvider = 'disabled' | 'local' | 'openai' | 'elevenlabs';

export type VoiceTtsPolicy = 'off' | 'manual_preview' | 'inbound_disabled' | 'smart_disabled';

export type VoiceTranscriptSource = 'local_model' | 'cloud_provider';

export type VoiceTranscriptPersistence = 'composer_only' | 'discarded';

export type VoiceReadinessReason =
  | 'voice_disabled'
  | 'permission_not_granted'
  | 'permission_restricted'
  | 'local_model_missing'
  | 'provider_not_ready'
  | 'cloud_not_enabled'
  | 'duration_exceeded'
  | 'audio_too_large'
  | 'invalid_audio_shape'
  | 'transcript_empty'
  | 'incognito_blocks_persistence'
  | 'raw_audio_persistence_forbidden'
  | 'telemetry_forbidden';

export type VoiceIntent = 'send_task' | 'dictate' | 'voice_chat';

export type VoiceAudioFormat = 'wav' | 'webm' | 'mp3' | 'm4a';

export interface EphemeralVoiceAudio {
  bytes: Uint8Array;
  mediaType: string;
  format: VoiceAudioFormat;
  durationMs: number;
  sampleRate: number;
  channels: number;
  transcript?: string;
  retention: 'operation_memory';
}

export interface VoiceModelRouteCapability {
  connectionSlug: string;
  modelId: string;
  providerLabel?: string;
  modalities: {
    input: Array<'text' | 'image' | 'audio'>;
    output: Array<'text' | 'image' | 'audio'>;
  };
  endpointRoles: Array<
    'agent_chat' | 'audio_chat' | 'transcription' | 'realtime_voice' | 'speech_generation'
  >;
  transports: Array<
    'openai_chat_audio' | 'openai_audio_transcriptions' | 'openai_realtime' | 'provider_native'
  >;
  transcriptOutput: boolean;
  adapterReady: boolean;
}

export interface VoiceRecognitionConfig {
  connectionSlug: string;
  model: string;
  language: string;
  prompt: string;
}

export interface VoiceRealtimeConfig {
  connectionSlug: string;
  model: string;
  voice: string;
}

export interface VoiceSettings {
  recognition: VoiceRecognitionConfig;
  realtime: VoiceRealtimeConfig;
}

export type VoiceRoutePlan =
  | {
      kind: 'native_audio_task';
      target: VoiceModelRouteCapability;
      transcriptProjection: 'provider' | 'configured_recognition' | 'marker_only';
    }
  | { kind: 'transcription_to_draft'; target: VoiceModelRouteCapability }
  | { kind: 'realtime_voice'; target: VoiceModelRouteCapability; transport: 'webrtc' }
  | {
      kind: 'blocked';
      reason:
        | 'recognition_not_configured'
        | 'realtime_not_configured'
        | 'model_not_ready'
        | 'adapter_unsupported'
        | 'permission_denied';
    };

export interface ResolveVoiceRouteInput {
  intent: VoiceIntent;
  currentAgent?: VoiceModelRouteCapability;
  recognition?: VoiceModelRouteCapability;
  realtime?: VoiceModelRouteCapability;
}

export interface VoiceBeginRequest {
  intent: VoiceIntent;
  currentAgent?: {
    connectionSlug: string;
    model: string;
  };
}

export type VoiceBeginResult =
  | {
      ok: true;
      operationId: string;
      route: VoiceRoutePlan;
      expiresAt: number;
    }
  | {
      ok: false;
      reason: Extract<VoiceRoutePlan, { kind: 'blocked' }>['reason'];
    };

export interface VoiceCapturedAudio {
  bytes: Uint8Array;
  mediaType: string;
  format: VoiceAudioFormat;
  durationMs: number;
  sampleRate: number;
  channels: number;
}

export type VoiceFinishCaptureResult =
  | {
      kind: 'transcript';
      operationId: string;
      text: string;
      providerLabel: string;
    }
  | {
      kind: 'native_audio_ready';
      operationId: string;
      providerLabel: string;
    };

export interface VoiceRealtimeClientSession {
  sessionId: string;
  answerSdp: string;
  model: string;
  providerLabel: string;
  expiresAt?: number;
}

export type VoiceCoordinatorToolName =
  | 'start_task'
  | 'steer_task'
  | 'check_task'
  | 'summarize_task';

export interface VoiceCoordinatorToolCall {
  name: VoiceCoordinatorToolName;
  arguments: {
    task?: string;
    guidance?: string;
  };
}

export interface VoiceCaptureCaps {
  maxDurationMs: number;
  maxAudioBytes: number;
  maxSampleRate: number;
  maxChannels: number;
}

export interface VoicePrivacyFlags {
  persistAudio: false;
  transcriptToMemory: false;
  telemetryIncludesRawAudio: false;
  telemetryIncludesTranscript: false;
}

export interface VoiceCapabilitySnapshot {
  inputMode: VoiceInputMode;
  microphonePermission: VoicePermissionStatus;
  sttProvider: VoiceSttProvider;
  localSttModelReady: boolean;
  cloudSttEnabled: boolean;
  ttsProvider: VoiceTtsProvider;
  ttsPolicy: VoiceTtsPolicy;
  captureCaps: VoiceCaptureCaps;
  privacy: VoicePrivacyFlags;
  readiness: 'disabled' | 'ready' | 'blocked';
  reasons: VoiceReadinessReason[];
}

export interface VoiceTranscriptResult {
  text: string;
  source: VoiceTranscriptSource;
  durationMs: number;
  sampleRate: number;
  channels: number;
  confidence?: number;
  editableBeforeSend: true;
  persistence: VoiceTranscriptPersistence;
}

export interface VoiceCaptureRequest {
  mode?: unknown;
  permission?: unknown;
  durationMs?: unknown;
  audioBytes?: unknown;
  sampleRate?: unknown;
  channels?: unknown;
  incognitoActive?: unknown;
}

export interface VoiceTranscriptRequest {
  text?: unknown;
  source?: unknown;
  durationMs?: unknown;
  sampleRate?: unknown;
  channels?: unknown;
  confidence?: unknown;
  persistence?: unknown;
  editableBeforeSend?: unknown;
}

export interface VoiceTtsRequest {
  text?: unknown;
  provider?: unknown;
  policy?: unknown;
}

export type VoiceNormalizeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: VoiceReadinessReason; error: string };

export function defaultVoiceCapabilitySnapshot(): VoiceCapabilitySnapshot {
  return {
    inputMode: 'off',
    microphonePermission: 'unknown',
    sttProvider: 'disabled',
    localSttModelReady: false,
    cloudSttEnabled: false,
    ttsProvider: 'disabled',
    ttsPolicy: 'off',
    captureCaps: defaultVoiceCaptureCaps(),
    privacy: defaultVoicePrivacyFlags(),
    readiness: 'disabled',
    reasons: ['voice_disabled'],
  };
}

export function defaultVoiceCaptureCaps(): VoiceCaptureCaps {
  return {
    maxDurationMs: VOICE_MAX_CAPTURE_DURATION_MS,
    maxAudioBytes: VOICE_MAX_AUDIO_BYTES,
    maxSampleRate: VOICE_MAX_SAMPLE_RATE,
    maxChannels: VOICE_MAX_CHANNELS,
  };
}

export function defaultVoicePrivacyFlags(): VoicePrivacyFlags {
  return {
    persistAudio: false,
    transcriptToMemory: false,
    telemetryIncludesRawAudio: false,
    telemetryIncludesTranscript: false,
  };
}

export function defaultVoiceSettings(): VoiceSettings {
  return {
    recognition: {
      connectionSlug: '',
      model: '',
      language: '',
      prompt: '',
    },
    realtime: {
      connectionSlug: '',
      model: '',
      voice: 'marin',
    },
  };
}

export function normalizeVoiceSettings(input: unknown): VoiceSettings {
  const defaults = defaultVoiceSettings();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaults;
  const value = input as {
    recognition?: unknown;
    realtime?: unknown;
  };
  const recognition =
    value.recognition && typeof value.recognition === 'object' && !Array.isArray(value.recognition)
      ? (value.recognition as Record<string, unknown>)
      : {};
  const realtime =
    value.realtime && typeof value.realtime === 'object' && !Array.isArray(value.realtime)
      ? (value.realtime as Record<string, unknown>)
      : {};
  return {
    recognition: {
      connectionSlug: boundedSettingString(recognition.connectionSlug, 64),
      model: boundedSettingString(recognition.model, 256),
      language: boundedSettingString(recognition.language, 32),
      prompt: boundedSettingString(recognition.prompt, 1_000),
    },
    realtime: {
      connectionSlug: boundedSettingString(realtime.connectionSlug, 64),
      model: boundedSettingString(realtime.model, 256),
      voice: boundedSettingString(realtime.voice, 64) || defaults.realtime.voice,
    },
  };
}

export function resolveVoiceRoute(input: ResolveVoiceRouteInput): VoiceRoutePlan {
  if (input.intent === 'voice_chat') {
    if (!input.realtime) return { kind: 'blocked', reason: 'realtime_not_configured' };
    if (!hasEndpoint(input.realtime, 'realtime_voice')) {
      return { kind: 'blocked', reason: 'model_not_ready' };
    }
    if (!hasTransport(input.realtime, 'openai_realtime') || !input.realtime.adapterReady) {
      return { kind: 'blocked', reason: 'adapter_unsupported' };
    }
    return { kind: 'realtime_voice', target: input.realtime, transport: 'webrtc' };
  }

  if (input.intent === 'send_task' && input.currentAgent) {
    const native = input.currentAgent;
    if (
      native.modalities.input.includes('audio') &&
      native.modalities.output.includes('text') &&
      hasEndpoint(native, 'audio_chat') &&
      hasTransport(native, 'openai_chat_audio') &&
      native.adapterReady
    ) {
      return {
        kind: 'native_audio_task',
        target: native,
        transcriptProjection: 'marker_only',
      };
    }
  }

  if (!input.recognition) return { kind: 'blocked', reason: 'recognition_not_configured' };
  if (!hasEndpoint(input.recognition, 'transcription')) {
    return { kind: 'blocked', reason: 'model_not_ready' };
  }
  if (
    !hasTransport(input.recognition, 'openai_audio_transcriptions') ||
    !input.recognition.adapterReady
  ) {
    return { kind: 'blocked', reason: 'adapter_unsupported' };
  }
  return { kind: 'transcription_to_draft', target: input.recognition };
}

export function normalizeVoiceCoordinatorToolCall(input: unknown): VoiceCoordinatorToolCall {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid voice coordinator tool call');
  }
  const value = input as { name?: unknown; arguments?: unknown };
  if (
    value.name !== 'start_task' &&
    value.name !== 'steer_task' &&
    value.name !== 'check_task' &&
    value.name !== 'summarize_task'
  ) {
    throw new Error('Unsupported voice coordinator tool');
  }
  const args =
    value.arguments && typeof value.arguments === 'object' && !Array.isArray(value.arguments)
      ? (value.arguments as Record<string, unknown>)
      : {};
  const task = boundedCoordinatorText(args.task);
  const guidance = boundedCoordinatorText(args.guidance);
  if (value.name === 'start_task' && !task) {
    throw new Error('Voice start_task requires a task');
  }
  if (value.name === 'steer_task' && !guidance) {
    throw new Error('Voice steer_task requires guidance');
  }
  return {
    name: value.name,
    arguments: {
      ...(task ? { task } : {}),
      ...(guidance ? { guidance } : {}),
    },
  };
}

export function normalizeVoiceInputMode(input: unknown): VoiceNormalizeResult<VoiceInputMode> {
  if (input === undefined || input === null || input === '') {
    return { ok: true, value: 'off' };
  }
  if (input === 'off' || input === 'push_to_talk' || input === 'toggle_to_record') {
    return { ok: true, value: input };
  }
  return { ok: false, reason: 'voice_disabled', error: 'Voice input mode is not supported' };
}

export function normalizeVoiceTtsPolicy(input: unknown): VoiceNormalizeResult<VoiceTtsPolicy> {
  if (input === undefined || input === null || input === '') {
    return { ok: true, value: 'off' };
  }
  if (
    input === 'off' ||
    input === 'manual_preview' ||
    input === 'inbound_disabled' ||
    input === 'smart_disabled'
  ) {
    return { ok: true, value: input };
  }
  return { ok: false, reason: 'voice_disabled', error: 'Voice TTS policy is not supported' };
}

export function normalizeVoiceTranscriptText(input: unknown): VoiceNormalizeResult<string> {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'transcript_empty', error: 'Transcript must be a string' };
  }
  const value = input
    .normalize('NFC')
    .replace(CONTROL_CHARS_REGEX, ' ')
    .replace(WHITESPACE_REGEX, ' ')
    .trim();
  if (value.length === 0) {
    return { ok: false, reason: 'transcript_empty', error: 'Transcript cannot be empty' };
  }
  const codePoints = Array.from(value);
  if (codePoints.length > VOICE_MAX_TRANSCRIPT_CHARS) {
    return { ok: true, value: codePoints.slice(0, VOICE_MAX_TRANSCRIPT_CHARS).join('') };
  }
  return { ok: true, value };
}

export function validateVoiceCaptureRequest(
  input: unknown,
): VoiceNormalizeResult<VoiceCaptureCaps> {
  const request = asRecord(input);
  if (!request.ok) return request;

  const mode = normalizeVoiceInputMode(request.value.mode);
  if (!mode.ok) return mode;
  if (mode.value === 'off') {
    return { ok: false, reason: 'voice_disabled', error: 'Voice capture is disabled' };
  }

  if (request.value.permission === 'denied') {
    return {
      ok: false,
      reason: 'permission_not_granted',
      error: 'Microphone permission is denied',
    };
  }
  if (request.value.permission === 'restricted') {
    return {
      ok: false,
      reason: 'permission_restricted',
      error: 'Microphone permission is restricted',
    };
  }
  if (request.value.permission !== 'granted') {
    return {
      ok: false,
      reason: 'permission_not_granted',
      error: 'Microphone permission is not granted',
    };
  }

  const duration = finiteNumber(
    request.value.durationMs,
    'duration_exceeded',
    'Capture duration must be a finite number',
  );
  if (!duration.ok) return duration;
  if (duration.value <= 0 || duration.value > VOICE_MAX_CAPTURE_DURATION_MS) {
    return {
      ok: false,
      reason: 'duration_exceeded',
      error: 'Voice capture duration exceeds the configured cap',
    };
  }

  const bytes = finiteNumber(
    request.value.audioBytes,
    'audio_too_large',
    'Audio size must be a finite number',
  );
  if (!bytes.ok) return bytes;
  if (bytes.value <= 0 || bytes.value > VOICE_MAX_AUDIO_BYTES) {
    return {
      ok: false,
      reason: 'audio_too_large',
      error: 'Voice capture audio exceeds the configured cap',
    };
  }

  const sampleRate = finiteNumber(
    request.value.sampleRate,
    'invalid_audio_shape',
    'Sample rate must be a finite number',
  );
  if (!sampleRate.ok) return sampleRate;
  if (sampleRate.value <= 0 || sampleRate.value > VOICE_MAX_SAMPLE_RATE) {
    return {
      ok: false,
      reason: 'invalid_audio_shape',
      error: 'Sample rate is outside the supported range',
    };
  }

  const channels = finiteNumber(
    request.value.channels,
    'invalid_audio_shape',
    'Channel count must be a finite number',
  );
  if (!channels.ok) return channels;
  if (
    !Number.isInteger(channels.value) ||
    channels.value < 1 ||
    channels.value > VOICE_MAX_CHANNELS
  ) {
    return {
      ok: false,
      reason: 'invalid_audio_shape',
      error: 'Channel count is outside the supported range',
    };
  }

  return { ok: true, value: defaultVoiceCaptureCaps() };
}

export function validateVoiceTranscriptResult(
  input: unknown,
): VoiceNormalizeResult<VoiceTranscriptResult> {
  const request = asRecord(input);
  if (!request.ok) return request;

  const text = normalizeVoiceTranscriptText(request.value.text);
  if (!text.ok) return text;
  if (request.value.source !== 'local_model' && request.value.source !== 'cloud_provider') {
    return { ok: false, reason: 'provider_not_ready', error: 'Transcript source is not supported' };
  }
  if (request.value.source === 'cloud_provider') {
    return {
      ok: false,
      reason: 'cloud_not_enabled',
      error: 'Cloud transcription is disabled by default',
    };
  }
  if (request.value.editableBeforeSend !== true) {
    return {
      ok: false,
      reason: 'transcript_empty',
      error: 'Transcript must be editable before send',
    };
  }
  if (request.value.persistence !== 'composer_only' && request.value.persistence !== 'discarded') {
    return {
      ok: false,
      reason: 'raw_audio_persistence_forbidden',
      error: 'Transcript persistence is not supported',
    };
  }

  const duration = finiteNumber(
    request.value.durationMs,
    'duration_exceeded',
    'Transcript duration must be a finite number',
  );
  if (!duration.ok) return duration;
  if (duration.value > VOICE_MAX_CAPTURE_DURATION_MS) {
    return {
      ok: false,
      reason: 'duration_exceeded',
      error: 'Transcript duration exceeds the configured cap',
    };
  }
  const sampleRate = finiteNumber(
    request.value.sampleRate,
    'invalid_audio_shape',
    'Sample rate must be a finite number',
  );
  if (!sampleRate.ok) return sampleRate;
  if (sampleRate.value <= 0 || sampleRate.value > VOICE_MAX_SAMPLE_RATE) {
    return {
      ok: false,
      reason: 'invalid_audio_shape',
      error: 'Transcript sample rate is outside the supported range',
    };
  }
  const channels = finiteNumber(
    request.value.channels,
    'invalid_audio_shape',
    'Channel count must be a finite number',
  );
  if (!channels.ok) return channels;
  if (
    !Number.isInteger(channels.value) ||
    channels.value < 1 ||
    channels.value > VOICE_MAX_CHANNELS
  ) {
    return {
      ok: false,
      reason: 'invalid_audio_shape',
      error: 'Transcript channel count is outside the supported range',
    };
  }

  if (request.value.confidence !== undefined) {
    const confidence = finiteNumber(
      request.value.confidence,
      'invalid_audio_shape',
      'Confidence must be a finite number',
    );
    if (!confidence.ok) return confidence;
    if (confidence.value < 0 || confidence.value > 1) {
      return {
        ok: false,
        reason: 'invalid_audio_shape',
        error: 'Confidence must be between 0 and 1',
      };
    }
  }

  return {
    ok: true,
    value: {
      text: text.value,
      source: request.value.source,
      durationMs: duration.value,
      sampleRate: sampleRate.value,
      channels: channels.value,
      confidence:
        typeof request.value.confidence === 'number' ? request.value.confidence : undefined,
      editableBeforeSend: true,
      persistence: request.value.persistence,
    },
  };
}

export function validateVoiceTtsRequest(
  input: unknown,
): VoiceNormalizeResult<{ text: string; provider: VoiceTtsProvider; policy: VoiceTtsPolicy }> {
  const request = asRecord(input);
  if (!request.ok) return request;

  const policy = normalizeVoiceTtsPolicy(request.value.policy);
  if (!policy.ok) return policy;
  if (policy.value !== 'manual_preview') {
    return {
      ok: false,
      reason: 'voice_disabled',
      error: 'Automatic voice output is disabled by contract',
    };
  }

  if (
    request.value.provider !== 'local' &&
    request.value.provider !== 'openai' &&
    request.value.provider !== 'elevenlabs'
  ) {
    return { ok: false, reason: 'provider_not_ready', error: 'TTS provider is not ready' };
  }

  const text = normalizeVoiceTranscriptText(request.value.text);
  if (!text.ok) return text;
  const codePoints = Array.from(text.value);
  return {
    ok: true,
    value: {
      text: codePoints.slice(0, VOICE_TTS_MAX_TEXT_CHARS).join(''),
      provider: request.value.provider,
      policy: policy.value,
    },
  };
}

function asRecord(input: unknown): VoiceNormalizeResult<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'voice_disabled', error: 'Voice request must be an object' };
  }
  return { ok: true, value: input as Record<string, unknown> };
}

function finiteNumber(
  input: unknown,
  reason: VoiceReadinessReason,
  error: string,
): VoiceNormalizeResult<number> {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return { ok: false, reason, error };
  }
  return { ok: true, value: input };
}

function hasEndpoint(
  capability: VoiceModelRouteCapability,
  endpoint: VoiceModelRouteCapability['endpointRoles'][number],
): boolean {
  return capability.endpointRoles.includes(endpoint);
}

function hasTransport(
  capability: VoiceModelRouteCapability,
  transport: VoiceModelRouteCapability['transports'][number],
): boolean {
  return capability.transports.includes(transport);
}

function boundedSettingString(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';
  return input.replace(CONTROL_CHARS_REGEX, '').trim().slice(0, maxLength);
}

function boundedCoordinatorText(input: unknown): string {
  if (typeof input !== 'string') return '';
  const text = input
    .normalize('NFC')
    .replace(CONTROL_CHARS_REGEX, ' ')
    .replace(WHITESPACE_REGEX, ' ')
    .trim();
  return Array.from(text).slice(0, VOICE_MAX_TRANSCRIPT_CHARS).join('');
}
