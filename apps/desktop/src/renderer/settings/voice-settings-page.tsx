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
  Badge,
  Button,
  FormLayout,
  PageHeader,
  Selector,
  TextArea,
  TextInput,
  formatBytes,
  useMountedRef,
  useToast,
  useUiLocale,
  Banner,
} from '@maka/ui';
import { getVoiceSettingsCopy, type VoiceSettingsCopy } from '../locales/settings-voice-copy';
import { AddProviderForm } from './provider-add-form';
import { ProviderConnectionDialog } from './provider-connection-dialog';
import { providerPanelActionErrorMessage } from './provider-panel-shared';
import { useActionGuard } from './use-action-guard';
import { useOptimisticSettingsDraft } from './use-optimistic-settings-draft';
import { VoiceRecognitionConnectionForm } from './voice-recognition-connection-form';
import { startVoiceCapture, type ActiveVoiceCapture } from '../voice-audio-capture';

type VoiceSmokeState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'recording' }
  | { status: 'ok'; durationMs: number; audioBytes: number }
  | { status: 'error'; reason: 'unsupported_media' | 'unsupported_recorder' | 'denied' | 'failed' | string };

type RecognitionDialogSession =
  | { kind: 'create'; phase: 'mounting' | 'open' | 'closing' }
  | { kind: 'edit'; phase: 'mounting' | 'open' | 'closing'; connection: LlmConnection };

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
  const toast = useToast();
  const [permission, setPermission] = useState<VoicePermissionStatus>('unknown');
  const [smoke, setSmoke] = useState<VoiceSmokeState>({ status: 'idle' });
  const [isBusy, setIsBusy] = useState(false);
  const [recognitionTest, setRecognitionTest] = useState<string>();
  const [recognitionTesting, setRecognitionTesting] = useState(false);
  const [recognitionDialog, setRecognitionDialog] = useState<RecognitionDialogSession | null>(null);
  const {
    draft: voiceDraft,
    draftRef: voiceDraftRef,
    saving,
    edit: editVoiceDraft,
    update: updateVoiceDraft,
  } = useOptimisticSettingsDraft<AppSettings['voice']>(
    props.settings.voice,
    async (patch) => {
      const result = await props.onUpdate({ voice: patch });
      return result.settings.voice;
    },
    {
      onError: (error) =>
        toast.error(copy.saveFailed, error instanceof Error ? error.message : copy.failed),
    },
  );
  const recognitionDraft = voiceDraft.recognition;
  const realtimeDraft = voiceDraft.realtime;
  const captureSmokeGuard = useActionGuard<'smoke'>();
  const recognitionTestGuard = useActionGuard<'recognition'>();
  const voicePageMountedRef = useMountedRef();
  const activeVoiceCaptureStreamRef = useRef<MediaStream | null>(null);
  const activeRecognitionTestRef = useRef<{
    operationId: string;
    capture?: ActiveVoiceCapture;
  } | undefined>(undefined);
  const caps = defaultVoiceCaptureCaps();
  const smokeStatusId = useId();
  const enabledConnections = props.connections.filter((connection) => connection.enabled);
  const selectedRecognitionConnection = enabledConnections.find(
    (connection) => connection.slug === recognitionDraft.connectionSlug,
  );
  const connectionOptions = [
    { value: '', label: copy.notConfigured },
    ...enabledConnections.map(
      (connection) => ({ value: connection.slug, label: connection.name }),
    ),
  ];

  useEffect(() => {
    if (!recognitionDialog || recognitionDialog.phase === 'open') return;
    const phase = recognitionDialog.phase;
    const frame = window.requestAnimationFrame(() => {
      setRecognitionDialog((current) => {
        if (!current || current.phase !== phase) return current;
        return phase === 'mounting' ? { ...current, phase: 'open' } : null;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [recognitionDialog?.phase]);

  function requestRecognitionDialogClose() {
    setRecognitionDialog((current) => current ? { ...current, phase: 'closing' } : null);
  }

  async function updateVoice(
    patch: {
      recognition?: Partial<AppSettings['voice']['recognition']>;
      realtime?: Partial<AppSettings['voice']['realtime']>;
    },
  ): Promise<boolean> {
    return updateVoiceDraft({
      ...(patch.recognition
        ? { recognition: { ...voiceDraftRef.current.recognition, ...patch.recognition } }
        : {}),
      ...(patch.realtime
        ? { realtime: { ...voiceDraftRef.current.realtime, ...patch.realtime } }
        : {}),
    });
  }

  function editVoice(
    patch: {
      recognition?: Partial<AppSettings['voice']['recognition']>;
      realtime?: Partial<AppSettings['voice']['realtime']>;
    },
  ): void {
    editVoiceDraft({
      ...(patch.recognition
        ? { recognition: { ...voiceDraftRef.current.recognition, ...patch.recognition } }
        : {}),
      ...(patch.realtime
        ? { realtime: { ...voiceDraftRef.current.realtime, ...patch.realtime } }
        : {}),
    });
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
      requestRecognitionDialogClose();
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
    requestRecognitionDialogClose();
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
      <FormLayout className="settingsFormLayout" direction="horizontal">
        <Selector
          value={recognitionDraft.connectionSlug}
          label={copy.connection}
          options={connectionOptions}
          isDisabled={saving}
          width="100%"
          onChange={(connectionSlug) =>
            void updateVoice({ recognition: { connectionSlug } })
          }
        />
        <TextInput
          value={recognitionDraft.model}
          onChange={(model) => editVoice({ recognition: { model } })}
          isDisabled={saving}
          placeholder="gpt-4o-mini-transcribe"
          label={copy.model}
          onBlur={() =>
            void updateVoice({ recognition: { model: recognitionDraft.model } })
          }
        />
        <TextInput
          value={recognitionDraft.language}
          onChange={(language) => editVoice({ recognition: { language } })}
          isDisabled={saving}
          placeholder="zh"
          label={copy.language}
          onBlur={() =>
            void updateVoice({ recognition: { language: recognitionDraft.language } })
          }
        />
        <TextArea
          value={recognitionDraft.prompt}
          onChange={(prompt) => editVoice({ recognition: { prompt } })}
          isDisabled={saving}
          label={copy.prompt}
          onBlur={() =>
            void updateVoice({ recognition: { prompt: recognitionDraft.prompt } })
          }
        />
      </FormLayout>
      <div className="settingsActionRow">
        <Button
          variant="secondary"
          type="button"
          isDisabled={saving || isBusy}
          onClick={() => setRecognitionDialog({ kind: 'create', phase: 'mounting' })}
          label={copy.createRecognitionConnection}
        />
        <Button
          variant="secondary"
          type="button"
          isDisabled={saving || isBusy || !selectedRecognitionConnection}
          onClick={() => {
            if (selectedRecognitionConnection) {
              setRecognitionDialog({
                kind: 'edit',
                phase: 'mounting',
                connection: selectedRecognitionConnection,
              });
            }
          }}
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
        <Banner status="info" role="status" title={recognitionTest} />
      ) : null}
      {recognitionDialog?.kind === 'create' ? (
        <ProviderConnectionDialog
          title={copy.createRecognitionConnectionTitle}
          subtitle={copy.createRecognitionConnectionSubtitle}
          providerType="openai-compatible"
          isOpen={recognitionDialog.phase === 'open'}
          onOpenChange={(isOpen) => {
            if (!isOpen) requestRecognitionDialogClose();
          }}
        >
          <AddProviderForm
            bridge={window.maka.connections}
            providerType="openai-compatible"
            existingSlugs={props.connections.map((connection) => connection.slug)}
            onCancel={requestRecognitionDialogClose}
            onCreated={async (slug) => {
              await finishCreatingRecognitionConnection(slug);
            }}
          />
        </ProviderConnectionDialog>
      ) : null}
      {recognitionDialog?.kind === 'edit' ? (
        <ProviderConnectionDialog
          title={copy.editRecognitionConnectionTitle}
          subtitle={copy.editRecognitionConnectionSubtitle(recognitionDialog.connection.name)}
          providerType={recognitionDialog.connection.providerType}
          isOpen={recognitionDialog.phase === 'open'}
          onOpenChange={(isOpen) => {
            if (!isOpen) requestRecognitionDialogClose();
          }}
        >
          <VoiceRecognitionConnectionForm
            bridge={window.maka.connections}
            connection={recognitionDialog.connection}
            model={recognitionDraft.model}
            onCancel={requestRecognitionDialogClose}
            onSaved={finishEditingRecognitionConnection}
          />
        </ProviderConnectionDialog>
      ) : null}
      <div className="settingsFeatureStatusHeroHeading">
        <h3>{copy.realtimeTitle}</h3>
      </div>
      <FormLayout className="settingsFormLayout" direction="horizontal">
        <Selector
          value={realtimeDraft.connectionSlug}
          label={copy.connection}
          options={connectionOptions}
          isDisabled={saving}
          width="100%"
          onChange={(connectionSlug) =>
            void updateVoice({ realtime: { connectionSlug } })
          }
        />
        <TextInput
          value={realtimeDraft.model}
          onChange={(model) => editVoice({ realtime: { model } })}
          isDisabled={saving}
          placeholder="gpt-realtime"
          label={copy.model}
          onBlur={() => void updateVoice({ realtime: { model: realtimeDraft.model } })}
        />
        <TextInput
          value={realtimeDraft.voice}
          onChange={(voice) => editVoice({ realtime: { voice } })}
          isDisabled={saving}
          placeholder="marin"
          label={copy.voice}
          onBlur={() => void updateVoice({ realtime: { voice: realtimeDraft.voice } })}
        />
      </FormLayout>
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
      <Banner
        status={smoke.status === 'error' ? 'error' : smoke.status === 'ok' ? 'success' : 'info'}
        id={smokeStatusId}
        role="status"
        title={voiceSmokeMessage(smoke, copy)} />
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
