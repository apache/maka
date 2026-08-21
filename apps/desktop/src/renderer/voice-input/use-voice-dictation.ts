import { useCallback, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ComposerDictation } from '@maka/ui';
import { PcmMicrophoneRecorder } from './pcm-recorder';
import { senseVoiceClient } from './sensevoice-client';

const MAX_RECORDING_SECONDS = 120;
const MIN_RECORDING_SAMPLES = 4_000;
const WAVEFORM_BAR_COUNT = 16;

function emptyWaveform(): number[] {
  return Array.from({ length: WAVEFORM_BAR_COUNT }, () => 0);
}

function copy(locale: UiLocale) {
  return locale === 'zh'
    ? {
        errorTitle: '语音输入失败',
        permission: '无法使用麦克风，请在系统设置中允许 Maka 访问麦克风。',
        empty: '没有识别到清晰语音，请重试。',
        unavailable: '本地语音模型不可用，请重新准备 SenseVoice 资源。',
      }
    : {
        errorTitle: 'Voice input failed',
        permission: 'Maka cannot use the microphone. Allow microphone access in system settings.',
        empty: 'No clear speech was recognized. Please try again.',
        unavailable: 'The local speech model is unavailable. Prepare the SenseVoice assets again.',
      };
}

function isPermissionError(error: unknown): boolean {
  return error instanceof DOMException
    && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
}

export function useVoiceDictation(input: {
  enabled: boolean;
  draftKey: string;
  locale: UiLocale;
  appendTranscript(draftKey: string, text: string): void;
  showError(title: string, detail: string): void;
}): ComposerDictation {
  const [state, setState] = useState<ComposerDictation['state']>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [loadProgress, setLoadProgress] = useState<number>();
  const [audioLevels, setAudioLevels] = useState<number[]>(emptyWaveform);
  const recorderRef = useRef<PcmMicrophoneRecorder | undefined>(undefined);
  const draftKeyRef = useRef(input.draftKey);
  const mountedRef = useRef(true);
  const stopRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void recorderRef.current?.cancel();
      recorderRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (input.enabled) return;
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    if (recorder) void recorder.cancel();
    setState((current) => current === 'requesting' || current === 'recording' ? 'idle' : current);
    setElapsedSeconds(0);
    setAudioLevels(emptyWaveform());
  }, [input.enabled]);

  useEffect(() => {
    if (state !== 'recording') return undefined;
    const startedAt = Date.now() - elapsedSeconds * 1_000;
    const timer = window.setInterval(() => {
      const next = Math.floor((Date.now() - startedAt) / 1_000);
      setElapsedSeconds(next);
      if (next >= MAX_RECORDING_SECONDS) void stopRef.current();
    }, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || state !== 'recording') return;
    recorderRef.current = undefined;
    setState('transcribing');
    setLoadProgress(undefined);
    setAudioLevels(emptyWaveform());
    const strings = copy(input.locale);
    try {
      const samples = await recorder.stop();
      if (samples.length < MIN_RECORDING_SAMPLES) throw new Error('empty-recording');
      const client = senseVoiceClient();
      client.onProgress = (progress) => {
        if (!mountedRef.current || progress.stage !== 'model' || !progress.total) return;
        setLoadProgress(Math.round((progress.loaded ?? 0) / progress.total * 100));
      };
      const text = await client.transcribe(samples);
      if (!text) throw new Error('empty-transcript');
      input.appendTranscript(draftKeyRef.current, text);
    } catch (error) {
      input.showError(
        strings.errorTitle,
        error instanceof Error && error.message.startsWith('empty-')
          ? strings.empty
          : strings.unavailable,
      );
    } finally {
      if (mountedRef.current) {
        setState('idle');
        setElapsedSeconds(0);
        setLoadProgress(undefined);
      }
    }
  }, [input, state]);
  stopRef.current = stop;

  const cancel = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || (state !== 'requesting' && state !== 'recording')) return;
    recorderRef.current = undefined;
    setState('idle');
    setElapsedSeconds(0);
    setLoadProgress(undefined);
    setAudioLevels(emptyWaveform());
    await recorder.cancel();
  }, [state]);

  const start = useCallback(async () => {
    if (!input.enabled || state !== 'idle') return;
    const recorder = new PcmMicrophoneRecorder((level) => {
      if (!mountedRef.current) return;
      setAudioLevels((current) => [...current.slice(1), level]);
    });
    recorderRef.current = recorder;
    draftKeyRef.current = input.draftKey;
    setElapsedSeconds(0);
    setAudioLevels(emptyWaveform());
    setState('requesting');
    try {
      await recorder.start();
      if (recorderRef.current !== recorder || !mountedRef.current) {
        await recorder.cancel();
        return;
      }
      setState('recording');
    } catch (error) {
      recorderRef.current = undefined;
      await recorder.cancel();
      const strings = copy(input.locale);
      input.showError(strings.errorTitle, isPermissionError(error) ? strings.permission : strings.unavailable);
      if (mountedRef.current) setState('idle');
    }
  }, [input, state]);

  return {
    state,
    elapsedSeconds,
    loadProgress,
    audioLevels,
    onStart: start,
    onStop: stop,
    onCancel: cancel,
  };
}
