import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_CAPTURE_DURATION_MS,
  type VoiceCapturedAudio,
} from '@maka/core';

const TARGET_SAMPLE_RATE = 16_000;
const SILENCE_RMS_THRESHOLD = 0.0005;

export interface ActiveVoiceCapture {
  stop(): Promise<VoiceCapturedAudio>;
  cancel(): void;
}

export async function startVoiceCapture(input: {
  maxDurationMs?: number;
  onAutoStop?(): void;
  onError?(error: Error): void;
} = {}): Promise<ActiveVoiceCapture> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('voice_media_unsupported');
  if (typeof MediaRecorder === 'undefined') throw new Error('voice_recorder_unsupported');
  const maxDurationMs = Math.min(
    input.maxDurationMs ?? VOICE_MAX_CAPTURE_DURATION_MS,
    VOICE_MAX_CAPTURE_DURATION_MS,
  );
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let recorder: MediaRecorder;
  try {
    recorder = createRecorder(stream);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const chunks: Blob[] = [];
  let chunkBytes = 0;
  let settled = false;
  let cancelled = false;
  let rejectStopped: ((error: Error) => void) | undefined;
  let timer: number | undefined;
  const startedAt = performance.now();
  const release = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    stream.getTracks().forEach((track) => track.stop());
  };
  const fail = (error: Error) => {
    rejectStopped?.(error);
    if (settled) return;
    settled = true;
    if (recorder.state !== 'inactive') recorder.stop();
    release();
    input.onError?.(error);
  };
  const stopped = new Promise<Blob>((resolve, reject) => {
    rejectStopped = reject;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size <= 0) return;
      chunkBytes += event.data.size;
      if (chunkBytes > VOICE_MAX_AUDIO_BYTES) {
        fail(new Error('voice_audio_too_large'));
        return;
      }
      chunks.push(event.data);
    });
    recorder.addEventListener(
      'error',
      () => fail(new Error('voice_recording_failed')),
      { once: true },
    );
    recorder.addEventListener(
      'stop',
      () => {
        if (cancelled) {
          reject(new Error('voice_capture_cancelled'));
          return;
        }
        resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      },
      { once: true },
    );
  });
  // Fatal recorder events own their cleanup and UI notification. Attach a
  // handler immediately so the promise cannot reject unobserved while the
  // caller is still in the recording state.
  void stopped.catch(() => {});
  try {
    recorder.start(250);
  } catch (error) {
    settled = true;
    release();
    throw error;
  }
  timer = window.setTimeout(() => {
    if (settled || recorder.state === 'inactive') return;
    input.onAutoStop?.();
    recorder.stop();
  }, maxDurationMs);

  return {
    async stop() {
      if (settled) throw new Error('voice_capture_already_finished');
      settled = true;
      if (recorder.state !== 'inactive') recorder.stop();
      try {
        const blob = await stopped;
        const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
        return await convertToMonoWav(blob, durationMs);
      } finally {
        release();
      }
    },
    cancel() {
      if (settled) return;
      settled = true;
      cancelled = true;
      rejectStopped?.(new Error('voice_capture_cancelled'));
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}

function createRecorder(stream: MediaStream): MediaRecorder {
  for (const mimeType of [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ]) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return new MediaRecorder(stream, { mimeType });
    }
  }
  return new MediaRecorder(stream);
}

async function convertToMonoWav(
  input: Blob,
  measuredDurationMs: number,
): Promise<VoiceCapturedAudio> {
  const AudioContextConstructor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor || typeof OfflineAudioContext === 'undefined') {
    throw new Error('voice_audio_conversion_unsupported');
  }
  const context = new AudioContextConstructor();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await input.arrayBuffer());
  } finally {
    await context.close().catch(() => {});
  }
  const durationMs = Math.min(
    VOICE_MAX_CAPTURE_DURATION_MS,
    Math.max(measuredDurationMs, Math.round(decoded.duration * 1_000)),
  );
  const frameCount = Math.max(1, Math.ceil((durationMs / 1_000) * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  if (rootMeanSquare(samples) < SILENCE_RMS_THRESHOLD) {
    throw new Error('voice_no_speech');
  }
  const bytes = encodePcm16Wav(samples, TARGET_SAMPLE_RATE);
  if (bytes.byteLength > VOICE_MAX_AUDIO_BYTES) throw new Error('voice_audio_too_large');
  return {
    bytes,
    mediaType: 'audio/wav',
    format: 'wav',
    durationMs,
    sampleRate: TARGET_SAMPLE_RATE,
    channels: 1,
  };
}

function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
