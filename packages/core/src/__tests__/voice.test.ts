import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_CAPTURE_DURATION_MS,
  defaultVoicePrivacyFlags,
  defaultVoiceSettings,
  normalizeVoiceCoordinatorToolCall,
  normalizeVoiceInputMode,
  normalizeVoiceSettings,
  normalizeVoiceTranscriptText,
  normalizeVoiceTtsPolicy,
  resolveVoiceRoute,
  type VoiceModelRouteCapability,
  validateVoiceCaptureRequest,
  validateVoiceTranscriptResult,
  validateVoiceTtsRequest,
} from '../voice.js';

const validCapture = {
  mode: 'push_to_talk',
  permission: 'granted',
  durationMs: 5_000,
  audioBytes: 256_000,
  sampleRate: 16_000,
  channels: 1,
};

const validTranscript = {
  text: 'hello',
  source: 'local_model',
  durationMs: 1_000,
  sampleRate: 16_000,
  channels: 1,
  editableBeforeSend: true,
  persistence: 'composer_only',
};

function capability(kind: 'native' | 'transcription' | 'realtime'): VoiceModelRouteCapability {
  return {
    connectionSlug: 'openai',
    modelId:
      kind === 'native'
        ? 'gpt-audio'
        : kind === 'transcription'
          ? 'gpt-4o-mini-transcribe'
          : 'gpt-realtime',
    modalities:
      kind === 'transcription'
        ? { input: ['audio'], output: ['text'] }
        : { input: ['text', 'audio'], output: ['text', 'audio'] },
    endpointRoles: [
      kind === 'native'
        ? 'audio_chat'
        : kind === 'transcription'
          ? 'transcription'
          : 'realtime_voice',
    ],
    transports: [
      kind === 'native'
        ? 'openai_chat_audio'
        : kind === 'transcription'
          ? 'openai_audio_transcriptions'
          : 'openai_realtime',
    ],
    transcriptOutput: kind === 'native',
    adapterReady: true,
  };
}

describe('voice privacy and modes', () => {
  it('defaults to non-persistent privacy and bounded opt-in modes', () => {
    assert.deepEqual(defaultVoicePrivacyFlags(), {
      persistAudio: false,
      transcriptToMemory: false,
      telemetryIncludesRawAudio: false,
      telemetryIncludesTranscript: false,
    });
    assert.deepEqual(normalizeVoiceInputMode(undefined), { ok: true, value: 'off' });
    assert.deepEqual(normalizeVoiceInputMode('push_to_talk'), {
      ok: true,
      value: 'push_to_talk',
    });
    assert.deepEqual(normalizeVoiceInputMode('toggle_to_record'), {
      ok: true,
      value: 'toggle_to_record',
    });
    assert.equal(normalizeVoiceInputMode('always_on').ok, false);
    assert.deepEqual(normalizeVoiceTtsPolicy(undefined), { ok: true, value: 'off' });
    assert.equal(normalizeVoiceTtsPolicy('always').ok, false);
    assert.equal(normalizeVoiceTtsPolicy('smart').ok, false);
  });
});

describe('voice capture validation', () => {
  it('accepts a bounded push-to-talk request', () => {
    assert.equal(validateVoiceCaptureRequest(validCapture).ok, true);
  });

  it('fails closed for malformed, disabled, unauthorized, or out-of-bounds capture', () => {
    for (const bad of [null, undefined, 'voice', 42, [], true]) {
      const result = validateVoiceCaptureRequest(bad);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.reason, 'voice_disabled');
    }
    for (const request of [
      { ...validCapture, mode: 'off' },
      { ...validCapture, permission: 'denied' },
      { ...validCapture, permission: 'restricted' },
      { ...validCapture, permission: 'not_determined' },
      { ...validCapture, durationMs: 0 },
      { ...validCapture, durationMs: VOICE_MAX_CAPTURE_DURATION_MS + 1 },
      { ...validCapture, audioBytes: 0 },
      { ...validCapture, audioBytes: VOICE_MAX_AUDIO_BYTES + 1 },
      { ...validCapture, sampleRate: 96_000 },
      { ...validCapture, channels: 2 },
    ]) {
      assert.equal(validateVoiceCaptureRequest(request).ok, false);
    }
  });
});

describe('voice route resolver', () => {
  it('selects native audio, transcription, and realtime only for explicit capabilities', () => {
    const native = resolveVoiceRoute({
      intent: 'send_task',
      currentAgent: capability('native'),
      recognition: capability('transcription'),
    });
    assert.equal(native.kind, 'native_audio_task');
    assert.equal(native.kind === 'native_audio_task' && native.transcriptProjection, 'marker_only');
    assert.equal(
      resolveVoiceRoute({
        intent: 'dictate',
        currentAgent: capability('native'),
        recognition: capability('transcription'),
      }).kind,
      'transcription_to_draft',
    );
    assert.equal(
      resolveVoiceRoute({ intent: 'voice_chat', realtime: capability('realtime') }).kind,
      'realtime_voice',
    );
  });

  it('fails closed without configuration or a ready adapter', () => {
    assert.deepEqual(resolveVoiceRoute({ intent: 'dictate' }), {
      kind: 'blocked',
      reason: 'recognition_not_configured',
    });
    assert.deepEqual(resolveVoiceRoute({ intent: 'voice_chat' }), {
      kind: 'blocked',
      reason: 'realtime_not_configured',
    });
    const native = capability('native');
    native.adapterReady = false;
    assert.deepEqual(resolveVoiceRoute({ intent: 'send_task', currentAgent: native }), {
      kind: 'blocked',
      reason: 'recognition_not_configured',
    });
    const realtime = capability('realtime');
    realtime.adapterReady = false;
    assert.deepEqual(resolveVoiceRoute({ intent: 'voice_chat', realtime }), {
      kind: 'blocked',
      reason: 'adapter_unsupported',
    });
  });
});

describe('voice settings and coordinator input', () => {
  it('normalizes settings and admits only bounded coordinator tools', () => {
    assert.deepEqual(normalizeVoiceSettings(undefined), defaultVoiceSettings());
    const normalized = normalizeVoiceSettings({
      recognition: { connectionSlug: ' openai ', model: ' transcribe ', language: ' zh ' },
      realtime: { connectionSlug: ' openai ', model: ' realtime ', voice: '' },
    });
    assert.equal(normalized.recognition.connectionSlug, 'openai');
    assert.equal(normalized.recognition.model, 'transcribe');
    assert.equal(normalized.recognition.language, 'zh');
    assert.equal(normalized.realtime.voice, 'marin');
    assert.deepEqual(
      normalizeVoiceCoordinatorToolCall({
        name: 'start_task',
        arguments: { task: '  inspect the repository  ' },
      }),
      { name: 'start_task', arguments: { task: 'inspect the repository' } },
    );
    assert.throws(() =>
      normalizeVoiceCoordinatorToolCall({
        name: 'run_shell',
        arguments: { command: 'rm -rf /' },
      }),
    );
    assert.throws(() => normalizeVoiceCoordinatorToolCall({ name: 'steer_task', arguments: {} }));
  });
});

describe('transcript validation', () => {
  it('sanitizes text and accepts bounded local composer-only transcripts', () => {
    assert.deepEqual(normalizeVoiceTranscriptText(' hello\u0000\nworld '), {
      ok: true,
      value: 'hello world',
    });
    assert.equal(validateVoiceTranscriptResult({ ...validTranscript, confidence: 0.9 }).ok, true);
  });

  it('rejects malformed, empty, non-editable, cloud, and out-of-bounds transcripts', () => {
    assert.equal(normalizeVoiceTranscriptText(' \n\t ').ok, false);
    for (const bad of [null, undefined, 'hello', 42, [], true]) {
      const result = validateVoiceTranscriptResult(bad);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.reason, 'voice_disabled');
    }
    for (const transcript of [
      { ...validTranscript, editableBeforeSend: false },
      { ...validTranscript, source: 'cloud_provider' },
      { ...validTranscript, durationMs: VOICE_MAX_CAPTURE_DURATION_MS + 1 },
      { ...validTranscript, sampleRate: 96_000 },
      { ...validTranscript, channels: 2 },
    ]) {
      assert.equal(validateVoiceTranscriptResult(transcript).ok, false);
    }
    const cloud = validateVoiceTranscriptResult({
      ...validTranscript,
      source: 'cloud_provider',
    });
    assert.equal(cloud.ok ? undefined : cloud.reason, 'cloud_not_enabled');
  });
});

describe('TTS validation', () => {
  it('allows only explicit manual preview with a ready provider', () => {
    for (const bad of [null, undefined, 'hello', 42, [], true]) {
      assert.equal(validateVoiceTtsRequest(bad).ok, false);
    }
    for (const policy of ['off', 'inbound_disabled', 'smart_disabled']) {
      const result = validateVoiceTtsRequest({ text: 'hello', provider: 'local', policy });
      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.reason, 'voice_disabled');
    }
    assert.equal(
      validateVoiceTtsRequest({ text: 'hello', provider: 'local', policy: 'manual_preview' }).ok,
      true,
    );
    const unavailable = validateVoiceTtsRequest({
      text: 'hello',
      provider: 'disabled',
      policy: 'manual_preview',
    });
    assert.equal(unavailable.ok ? undefined : unavailable.reason, 'provider_not_ready');
  });
});
