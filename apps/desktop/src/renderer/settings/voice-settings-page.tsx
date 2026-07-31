import { useEffect, useId, useRef, useState } from 'react';
import { Volume2 } from '@maka/ui/icons';
import type { VoicePermissionStatus } from '@maka/core';
import { defaultVoiceCaptureCaps, validateVoiceCaptureRequest } from '@maka/core';
import { Alert, AlertDescription, Badge, Button, PageHeader, formatBytes, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { getVoiceSettingsCopy, type VoiceSettingsCopy } from '../locales/settings-voice-copy';
import { useActionGuard } from './use-action-guard';

type VoiceSmokeState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'recording' }
  | { status: 'ok'; durationMs: number; audioBytes: number }
  | { status: 'error'; reason: 'unsupported_media' | 'unsupported_recorder' | 'denied' | 'failed' | string };

export function VoiceModelsSettingsPage() {
  const locale = useUiLocale();
  const copy = getVoiceSettingsCopy(locale);
  const [permission, setPermission] = useState<VoicePermissionStatus>('unknown');
  const [smoke, setSmoke] = useState<VoiceSmokeState>({ status: 'idle' });
  const [isBusy, setIsBusy] = useState(false);
  const captureSmokeGuard = useActionGuard<'smoke'>();
  const voicePageMountedRef = useMountedRef();
  const activeVoiceCaptureStreamRef = useRef<MediaStream | null>(null);
  const toast = useToast();
  const caps = defaultVoiceCaptureCaps();
  const smokeStatusId = useId();

  useEffect(() => {
    return () => {
      activeVoiceCaptureStreamRef.current?.getTracks().forEach((track) => track.stop());
      activeVoiceCaptureStreamRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let permissionReadRevision = 0;
    const refreshPermission = () => {
      const revision = ++permissionReadRevision;
      void readMicrophonePermission().then((next) => {
        if (!cancelled && revision === permissionReadRevision) setPermission(next);
      });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshPermission();
    };
    refreshPermission();
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  async function runCaptureSmoke() {
    if (captureSmokeGuard.current !== null) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermission('unsupported');
      setSmoke({ status: 'error', reason: 'unsupported_media' });
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setPermission('unsupported');
      setSmoke({ status: 'error', reason: 'unsupported_recorder' });
      return;
    }

    captureSmokeGuard.begin('smoke');
    setIsBusy(true);
    setSmoke({ status: 'checking' });
    let stream: MediaStream | null = null;
    try {
      const systemSnapshot = await window.maka.permissions.getSnapshot().catch(() => null);
      const systemMicrophone = systemSnapshot?.permissions.microphone;
      if (
        systemSnapshot?.platform === 'darwin'
        && systemMicrophone
        && systemMicrophone.status !== 'granted'
        && systemMicrophone.status !== 'not_determined'
      ) {
        const opened = await window.maka.permissions.openSystemSettings('microphone');
        if (voicePageMountedRef.current) {
          const denied = systemMicrophone.status === 'denied';
          setPermission(denied ? 'denied' : 'unknown');
          setSmoke({ status: 'error', reason: denied ? 'denied' : 'failed' });
          if (!opened.ok) toast.error(copy.failedTitle, copy.failed);
        }
        return;
      }
      if (
        systemSnapshot?.platform === 'darwin'
        && systemMicrophone?.status === 'not_determined'
      ) {
        const requested = await window.maka.permissions.requestAccess('microphone');
        if (!requested.ok) {
          if (voicePageMountedRef.current) {
            const denied = requested.reason === 'denied';
            setPermission(denied ? 'denied' : 'unknown');
            setSmoke({ status: 'error', reason: denied ? 'denied' : 'failed' });
            toast.error(copy.failedTitle, denied ? copy.denied : copy.failed);
          }
          return;
        }
      }
      if (!voicePageMountedRef.current) return;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: caps.maxChannels,
          sampleRate: caps.maxSampleRate,
        },
      });
      activeVoiceCaptureStreamRef.current = stream;
      if (!voicePageMountedRef.current) return;
      setPermission('granted');
      setSmoke({ status: 'recording' });
      const startedAt = performance.now();
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      const stopped = new Promise<void>((resolve, reject) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.addEventListener('error', () => reject(new Error('voice_recording_check_failed')), { once: true });
      });
      recorder.start();
      await waitMs(2_000);
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      const durationMs = Math.round(performance.now() - startedAt);
      const audioBytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      const validation = validateVoiceCaptureRequest({
        mode: 'push_to_talk',
        permission: 'granted',
        durationMs,
        audioBytes,
        sampleRate: caps.maxSampleRate,
        channels: caps.maxChannels,
      });
      if (!validation.ok) {
        if (voicePageMountedRef.current) {
          setSmoke({ status: 'error', reason: validation.reason });
        }
        return;
      }
      const message = copy.available(formatVoiceDuration(durationMs, copy), formatBytes(audioBytes));
      if (voicePageMountedRef.current) {
        setSmoke({ status: 'ok', durationMs, audioBytes });
        toast.success(copy.success, message);
      }
    } catch (error) {
      const next = classifyVoicePermissionError(error);
      const reason = next === 'denied' ? 'denied' : 'failed';
      const message = reason === 'denied' ? copy.denied : copy.failed;
      if (voicePageMountedRef.current) {
        setPermission(next);
        setSmoke({ status: 'error', reason });
        toast.error(copy.failedTitle, message);
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (activeVoiceCaptureStreamRef.current === stream) {
        activeVoiceCaptureStreamRef.current = null;
      }
      captureSmokeGuard.finish();
      if (voicePageMountedRef.current) {
        setIsBusy(false);
      }
    }
  }

  return (
    <section className="settingsFeatureStatusPage" aria-label={copy.aria}>
      {/* Detail sweep: the always-on shipped-feature announcement banner is
          gone — release notes don't live in settings, and its privacy copy
          duplicated the privacy tile and boundary section below. (daily-review
          made the same banner exception-only earlier.) */}
      <PageHeader
        as_wrapper="div"
        className="settingsFeatureStatusHero"
        as="h3"
        icon={<Volume2 size={24} />}
        iconClassName="settingsFeatureStatusIcon"
        headingRowClassName="settingsFeatureStatusHeroHeading"
        title={copy.title}
        badge={<Badge variant="neutral" label={copy.badge} />}
        subtitle={copy.subtitle}
      />

      <dl className="settingsBotStatusGrid" aria-label={copy.statusAria}>
        <div>
          <dt>{copy.microphone}</dt>
          <dd>{copy.permissions[permission]}</dd>
        </div>
        <div>
          <dt>{copy.captureLimit}</dt>
          <dd>{copy.durationSize(Math.round(caps.maxDurationMs / 1000), Math.round(caps.maxAudioBytes / 1024 / 1024))}</dd>
        </div>
        <div>
          <dt>{copy.channels}</dt>
          <dd>{copy.channelValue(Math.round(caps.maxSampleRate / 1000))}</dd>
        </div>
        <div>
          <dt>{copy.privacy}</dt>
          <dd>{copy.privacyValue}</dd>
        </div>
      </dl>

      <div className="settingsActionRow">
        <Button
          variant="primary"
          onClick={() => void runCaptureSmoke()}
          isDisabled={isBusy}
          aria-busy={isBusy}
          aria-describedby={smokeStatusId}
          data-pending={isBusy ? 'true' : undefined}
          label={isBusy ? copy.checking : copy.run}
        />
      </div>

      <Alert
        id={smokeStatusId}
        variant={smoke.status === 'error' ? 'error' : smoke.status === 'ok' ? 'success' : 'passive'}
        role="status"
      >
        <AlertDescription>{voiceSmokeMessage(smoke, copy)}</AlertDescription>
      </Alert>

      <div className="settingsFeatureStatusHeroHeading">
        <h3>{copy.boundary}</h3>
      </div>
      <ul className="settingsFeatureStatusList" aria-label={copy.boundaryAria}>
        {copy.boundaries.map((boundary) => <li key={boundary}>{boundary}</li>)}
      </ul>
    </section>
  );
}

async function readMicrophonePermission(): Promise<VoicePermissionStatus> {
  try {
    const snapshot = await window.maka.permissions.getSnapshot();
    const status = snapshot.permissions.microphone.status;
    if (status !== 'unknown' && status !== 'unsupported') return status;
  } catch {
    // Fall through to the renderer probe. It is useful on platforms where
    // Electron cannot expose an OS-level microphone status.
  }
  return readBrowserMicrophonePermission();
}

async function readBrowserMicrophonePermission(): Promise<VoicePermissionStatus> {
  const query = (navigator.permissions as { query?: (descriptor: { name: string }) => Promise<{ state: string }> } | undefined)?.query;
  if (!query) return 'unknown';
  try {
    const result = await query.call(navigator.permissions, { name: 'microphone' });
    if (result.state === 'granted') return 'granted';
    if (result.state === 'denied') return 'denied';
    if (result.state === 'prompt') return 'not_determined';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function classifyVoicePermissionError(error: unknown): VoicePermissionStatus {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'NotReadableError') return 'unsupported';
  return 'unknown';
}

function voiceSmokeMessage(smoke: VoiceSmokeState, copy: VoiceSettingsCopy): string {
  if (smoke.status === 'idle') return copy.idle;
  if (smoke.status === 'checking') return copy.requesting;
  if (smoke.status === 'recording') return copy.recording;
  if (smoke.status === 'ok') {
    return copy.available(formatVoiceDuration(smoke.durationMs, copy), formatBytes(smoke.audioBytes));
  }
  if (smoke.reason === 'unsupported_media') return copy.unsupportedMedia;
  if (smoke.reason === 'unsupported_recorder') return copy.unsupportedRecorder;
  if (smoke.reason === 'denied') return copy.denied;
  if (smoke.reason === 'failed') return copy.failed;
  return copy.validation[smoke.reason as keyof VoiceSettingsCopy['validation']] ?? copy.validation.default;
}

function formatVoiceDuration(durationMs: number, copy: VoiceSettingsCopy): string {
  return copy.duration(Math.max(0, durationMs / 1000).toFixed(1));
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
