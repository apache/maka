import { useEffect, useId, useRef, useState } from 'react';
import { Volume2 } from '@maka/ui/icons';
import type {
  AppSettings,
  LlmConnection,
  UpdateAppSettingsResult,
  VoicePermissionStatus,
} from '@maka/core';
import { defaultVoiceCaptureCaps, validateVoiceCaptureRequest } from '@maka/core';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Input,
  PageHeader,
  SettingsSelect,
  Textarea,
  formatBytes,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { getVoiceSettingsCopy, type VoiceSettingsCopy } from '../locales/settings-voice-copy';
import { AddProviderForm } from './provider-add-form';
import { ProviderConnectionDialog } from './provider-connection-dialog';
import { providerPanelActionErrorMessage } from './provider-panel-shared';
import { useActionGuard } from './use-action-guard';
import { VoiceRecognitionConnectionForm } from './voice-recognition-connection-form';
import { startVoiceCapture, type ActiveVoiceCapture } from '../voice-audio-capture';

type VoiceSmokeState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'recording' }
  | { status: 'ok'; durationMs: number; audioBytes: number }
  | { status: 'error'; reason: 'unsupported_media' | 'unsupported_recorder' | 'denied' | 'failed' | string };

export function VoiceModelsSettingsPage(props: {
  settings: AppSettings;
  connections: LlmConnection[];
  onUpdate(
    patch: Parameters<typeof window.maka.settings.update>[0],
  ): Promise<UpdateAppSettingsResult>;
  onRefreshConnections(): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getVoiceSettingsCopy(locale);
  const [permission, setPermission] = useState<VoicePermissionStatus>('unknown');
  const [smoke, setSmoke] = useState<VoiceSmokeState>({ status: 'idle' });
  const [isBusy, setIsBusy] = useState(false);
  const [recognitionTest, setRecognitionTest] = useState<string>();
  const [recognitionTesting, setRecognitionTesting] = useState(false);
  const [creatingRecognitionConnection, setCreatingRecognitionConnection] = useState(false);
  const [editingRecognitionConnection, setEditingRecognitionConnection] = useState(false);
  const [saving, setSaving] = useState(false);
  const captureSmokeGuard = useActionGuard<'smoke'>();
  const recognitionTestGuard = useActionGuard<'recognition'>();
  const voicePageMountedRef = useMountedRef();
  const activeVoiceCaptureStreamRef = useRef<MediaStream | null>(null);
  const activeRecognitionTestRef = useRef<{
    operationId: string;
    capture?: ActiveVoiceCapture;
  } | undefined>(undefined);
  const createRecognitionConnectionButtonRef = useRef<HTMLButtonElement | null>(null);
  const editRecognitionConnectionButtonRef = useRef<HTMLButtonElement | null>(null);
  const toast = useToast();
  const caps = defaultVoiceCaptureCaps();
  const smokeStatusId = useId();
  const enabledConnections = props.connections.filter((connection) => connection.enabled);
  const selectedRecognitionConnection = enabledConnections.find(
    (connection) => connection.slug === props.settings.voice.recognition.connectionSlug,
  );
  const connectionOptions = [
    ['', copy.notConfigured],
    ...enabledConnections.map(
      (connection) => [connection.slug, connection.name] as const,
    ),
  ] as Array<readonly [string, string]>;

  async function updateVoice(
    patch: {
      recognition?: Partial<AppSettings['voice']['recognition']>;
      realtime?: Partial<AppSettings['voice']['realtime']>;
    },
  ): Promise<boolean> {
    setSaving(true);
    try {
      await props.onUpdate({
        voice: patch,
      });
      return true;
    } catch (error) {
      toast.error(copy.saveFailed, error instanceof Error ? error.message : copy.failed);
      return false;
    } finally {
      if (voicePageMountedRef.current) setSaving(false);
    }
  }

  async function finishCreatingRecognitionConnection(slug: string): Promise<void> {
    try {
      const connections = await window.maka.connections.list();
      const created = connections.find((connection) => connection.slug === slug);
      if (!created?.defaultModel.trim()) {
        throw new Error(copy.recognitionConnectionModelMissing);
      }
      const saved = await updateVoice({
        recognition: {
          connectionSlug: created.slug,
          model: created.defaultModel,
        },
      });
      if (!saved || !voicePageMountedRef.current) return;
      await props.onRefreshConnections();
      if (!voicePageMountedRef.current) return;
      setCreatingRecognitionConnection(false);
      toast.success(
        copy.recognitionConnectionCreated,
        copy.recognitionConnectionCreatedDetail(created.name, created.defaultModel),
      );
    } catch (error) {
      if (!voicePageMountedRef.current) return;
      toast.error(
        copy.recognitionConnectionCreateFailed,
        providerPanelActionErrorMessage(error, locale),
      );
    }
  }

  async function finishEditingRecognitionConnection(
    connection: LlmConnection,
    model: string,
  ): Promise<void> {
    const saved = await updateVoice({
      recognition: {
        connectionSlug: connection.slug,
        model,
      },
    });
    if (!saved || !voicePageMountedRef.current) {
      throw new Error(copy.recognitionConnectionUpdateFailed);
    }
    await props.onRefreshConnections();
    if (!voicePageMountedRef.current) return;
    setEditingRecognitionConnection(false);
    toast.success(
      copy.recognitionConnectionUpdated,
      copy.recognitionConnectionUpdatedDetail(connection.name, model),
    );
  }

  async function runRecognitionTest(): Promise<void> {
    if (!recognitionTestGuard.begin('recognition')) return;
    setRecognitionTesting(true);
    setRecognitionTest(copy.recognitionTesting);
    let operationId: string | undefined;
    try {
      const begin = await window.maka.voice.begin({ intent: 'dictate' });
      if (!begin.ok) throw new Error(begin.reason);
      operationId = begin.operationId;
      activeRecognitionTestRef.current = { operationId };
      if (!voicePageMountedRef.current) {
        await window.maka.voice.cancel(operationId).catch(() => {});
        operationId = undefined;
        return;
      }
      const capture = await startVoiceCapture({ maxDurationMs: 4_000 });
      if (
        !voicePageMountedRef.current ||
        activeRecognitionTestRef.current?.operationId !== operationId
      ) {
        capture.cancel();
        await window.maka.voice.cancel(operationId).catch(() => {});
        operationId = undefined;
        return;
      }
      activeRecognitionTestRef.current.capture = capture;
      await waitMs(4_000);
      const audio = await capture.stop();
      if (activeRecognitionTestRef.current?.operationId === operationId) {
        activeRecognitionTestRef.current.capture = undefined;
      }
      const result = await window.maka.voice.finishCapture(begin.operationId, audio);
      if (result.kind !== 'transcript') throw new Error('recognition_test_no_transcript');
      operationId = undefined;
      activeRecognitionTestRef.current = undefined;
      if (!voicePageMountedRef.current) return;
      setRecognitionTest(result.text);
      toast.success(copy.recognitionSuccess, result.text);
    } catch (error) {
      if (operationId) await window.maka.voice.cancel(operationId).catch(() => {});
      if (activeRecognitionTestRef.current?.operationId === operationId) {
        activeRecognitionTestRef.current = undefined;
      }
      if (!voicePageMountedRef.current) return;
      const message = error instanceof Error ? error.message : copy.failed;
      setRecognitionTest(message);
      toast.error(copy.recognitionFailed, message);
    } finally {
      recognitionTestGuard.finish();
      if (voicePageMountedRef.current) setRecognitionTesting(false);
    }
  }

  useEffect(() => {
    return () => {
      const recognitionTest = activeRecognitionTestRef.current;
      activeRecognitionTestRef.current = undefined;
      recognitionTest?.capture?.cancel();
      if (recognitionTest) {
        void window.maka.voice.cancel(recognitionTest.operationId).catch(() => {});
      }
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

      <div className="settingsFeatureStatusHeroHeading">
        <h3>{copy.recognitionTitle}</h3>
      </div>
      <div className="settingsFormGrid settingsFormGridProxy">
        <label>
          <span>{copy.connection}</span>
          <SettingsSelect
            value={props.settings.voice.recognition.connectionSlug}
            ariaLabel={copy.recognitionConnectionAria}
            options={connectionOptions}
            disabled={saving}
            onChange={(connectionSlug) =>
              void updateVoice({ recognition: { connectionSlug } })
            }
          />
        </label>
        <label>
          <span>{copy.model}</span>
          <Input
            key={`recognition-model:${props.settings.voice.recognition.model}`}
            defaultValue={props.settings.voice.recognition.model}
            disabled={saving}
            placeholder="gpt-4o-mini-transcribe"
            aria-label={copy.recognitionModelAria}
            onBlur={(event) =>
              void updateVoice({ recognition: { model: event.currentTarget.value } })
            }
          />
        </label>
        <label>
          <span>{copy.language}</span>
          <Input
            key={`recognition-language:${props.settings.voice.recognition.language}`}
            defaultValue={props.settings.voice.recognition.language}
            disabled={saving}
            placeholder="zh"
            aria-label={copy.language}
            onBlur={(event) =>
              void updateVoice({ recognition: { language: event.currentTarget.value } })
            }
          />
        </label>
        <label>
          <span>{copy.prompt}</span>
          <Textarea
            key={`recognition-prompt:${props.settings.voice.recognition.prompt}`}
            defaultValue={props.settings.voice.recognition.prompt}
            disabled={saving}
            aria-label={copy.prompt}
            onBlur={(event) =>
              void updateVoice({ recognition: { prompt: event.currentTarget.value } })
            }
          />
        </label>
      </div>
      <div className="settingsActionRow">
        <Button
          ref={createRecognitionConnectionButtonRef}
          variant="secondary"
          type="button"
          isDisabled={saving || isBusy}
          onClick={() => setCreatingRecognitionConnection(true)}
          label={copy.createRecognitionConnection}
        />
        <Button
          ref={editRecognitionConnectionButtonRef}
          variant="secondary"
          type="button"
          isDisabled={saving || isBusy || !selectedRecognitionConnection}
          onClick={() => setEditingRecognitionConnection(true)}
          label={copy.editRecognitionConnection}
        />
        <Button
          variant="primary"
          type="button"
          isDisabled={saving || isBusy || recognitionTesting}
          onClick={() => void runRecognitionTest()}
          label={copy.testRecognition}
        />
      </div>
      {recognitionTest ? (
        <Alert variant="passive" role="status">
          <AlertDescription>{recognitionTest}</AlertDescription>
        </Alert>
      ) : null}

      {creatingRecognitionConnection ? (
        <ProviderConnectionDialog
          title={copy.createRecognitionConnectionTitle}
          subtitle={copy.createRecognitionConnectionSubtitle}
          providerType="openai-compatible"
          onClose={() => setCreatingRecognitionConnection(false)}
          finalFocus={() => createRecognitionConnectionButtonRef.current}
        >
          <AddProviderForm
            bridge={window.maka.connections}
            providerType="openai-compatible"
            existingSlugs={props.connections.map((connection) => connection.slug)}
            onCancel={() => setCreatingRecognitionConnection(false)}
            onCreated={async (slug) => {
              await finishCreatingRecognitionConnection(slug);
            }}
          />
        </ProviderConnectionDialog>
      ) : null}

      {editingRecognitionConnection && selectedRecognitionConnection ? (
        <ProviderConnectionDialog
          title={copy.editRecognitionConnectionTitle}
          subtitle={copy.editRecognitionConnectionSubtitle(selectedRecognitionConnection.name)}
          providerType={selectedRecognitionConnection.providerType}
          onClose={() => setEditingRecognitionConnection(false)}
          finalFocus={() => editRecognitionConnectionButtonRef.current}
        >
          <VoiceRecognitionConnectionForm
            bridge={window.maka.connections}
            connection={selectedRecognitionConnection}
            model={props.settings.voice.recognition.model}
            onCancel={() => setEditingRecognitionConnection(false)}
            onSaved={finishEditingRecognitionConnection}
          />
        </ProviderConnectionDialog>
      ) : null}

      <div className="settingsFeatureStatusHeroHeading">
        <h3>{copy.realtimeTitle}</h3>
      </div>
      <div className="settingsFormGrid settingsFormGridProxy">
        <label>
          <span>{copy.connection}</span>
          <SettingsSelect
            value={props.settings.voice.realtime.connectionSlug}
            ariaLabel={copy.realtimeConnectionAria}
            options={connectionOptions}
            disabled={saving}
            onChange={(connectionSlug) =>
              void updateVoice({ realtime: { connectionSlug } })
            }
          />
        </label>
        <label>
          <span>{copy.model}</span>
          <Input
            key={`realtime-model:${props.settings.voice.realtime.model}`}
            defaultValue={props.settings.voice.realtime.model}
            disabled={saving}
            placeholder="gpt-realtime"
            aria-label={copy.realtimeModelAria}
            onBlur={(event) =>
              void updateVoice({ realtime: { model: event.currentTarget.value } })
            }
          />
        </label>
        <label>
          <span>{copy.voice}</span>
          <Input
            key={`realtime-voice:${props.settings.voice.realtime.voice}`}
            defaultValue={props.settings.voice.realtime.voice}
            disabled={saving}
            placeholder="marin"
            aria-label={copy.voice}
            onBlur={(event) =>
              void updateVoice({ realtime: { voice: event.currentTarget.value } })
            }
          />
        </label>
      </div>

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
