import { useEffect, useRef, useState } from 'react';
import type {
  VoiceCoordinatorToolCall,
  VoiceRoutePlan,
} from '@maka/core';
import { startVoiceCapture, type ActiveVoiceCapture } from './voice-audio-capture.js';

export type ComposerVoiceCaptureState =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'processing'
  | 'native_ready'
  | 'sending';

export type ComposerRealtimeVoiceState =
  | 'idle'
  | 'connecting'
  | 'connected';

export interface VoiceInputController {
  captureState: ComposerVoiceCaptureState;
  realtimeState: ComposerRealtimeVoiceState;
  providerLabel?: string;
  routeKind?: Exclude<VoiceRoutePlan['kind'], 'blocked'>;
  toggleCapture(input?: { dictate?: boolean }): Promise<void>;
  cancelCapture(): void;
  toggleRealtime(): Promise<void>;
}

export function useVoiceInput(input: {
  getDraftKey(): string;
  getCurrentAgent(): { connectionSlug: string; model: string } | undefined;
  appendTranscript(draftKey: string, text: string): void;
  sendNativeVoice(operationId: string): Promise<boolean>;
  runCoordinatorTool(call: VoiceCoordinatorToolCall): Promise<unknown>;
  onBlocked(reason: string): void;
  onError(error: unknown): void;
}): VoiceInputController {
  const [captureState, setCaptureState] =
    useState<ComposerVoiceCaptureState>('idle');
  const [realtimeState, setRealtimeState] =
    useState<ComposerRealtimeVoiceState>('idle');
  const [providerLabel, setProviderLabel] = useState<string>();
  const [routeKind, setRouteKind] =
    useState<Exclude<VoiceRoutePlan['kind'], 'blocked'>>();
  const activeCaptureRef = useRef<ActiveVoiceCapture | undefined>(undefined);
  const operationRef = useRef<{
    id: string;
    draftKey: string;
    route: Exclude<VoiceRoutePlan, { kind: 'blocked' }>;
  } | undefined>(undefined);
  const realtimeRef = useRef<{
    sessionId: string;
    peer: RTCPeerConnection;
    stream: MediaStream;
    audio: HTMLAudioElement;
    channel: RTCDataChannel;
  } | undefined>(undefined);
  const realtimeRevisionRef = useRef(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !operationRef.current) return;
      event.preventDefault();
      cancelCapture();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      cancelCapture();
      closeRealtime();
    };
  }, []);

  async function toggleCapture(options: { dictate?: boolean } = {}): Promise<void> {
    if (captureState === 'recording') {
      await finishCapture();
      return;
    }
    if (captureState === 'native_ready') {
      await sendNative();
      return;
    }
    if (captureState !== 'idle') return;
    setCaptureState('requesting');
    try {
      const begin = await window.maka.voice.begin({
        intent: options.dictate ? 'dictate' : 'send_task',
        ...(input.getCurrentAgent() ? { currentAgent: input.getCurrentAgent() } : {}),
      });
      if (!begin.ok) {
        setCaptureState('idle');
        input.onBlocked(begin.reason);
        return;
      }
      if (begin.route.kind === 'blocked' || begin.route.kind === 'realtime_voice') {
        await window.maka.voice.cancel(begin.operationId).catch(() => {});
        setCaptureState('idle');
        input.onBlocked('adapter_unsupported');
        return;
      }
      operationRef.current = {
        id: begin.operationId,
        draftKey: input.getDraftKey(),
        route: begin.route,
      };
      setProviderLabel(begin.route.target.providerLabel ?? begin.route.target.connectionSlug);
      setRouteKind(begin.route.kind);
      const capture = await startVoiceCapture({
        onAutoStop: () => {
          window.queueMicrotask(() => {
            void finishCapture();
          });
        },
      });
      activeCaptureRef.current = capture;
      setCaptureState('recording');
    } catch (error) {
      const operation = operationRef.current;
      operationRef.current = undefined;
      activeCaptureRef.current?.cancel();
      activeCaptureRef.current = undefined;
      if (operation) await window.maka.voice.cancel(operation.id).catch(() => {});
      setCaptureState('idle');
      input.onError(error);
    }
  }

  async function finishCapture(): Promise<void> {
    const operation = operationRef.current;
    const capture = activeCaptureRef.current;
    if (!operation || !capture) return;
    activeCaptureRef.current = undefined;
    setCaptureState('processing');
    try {
      const audio = await capture.stop();
      const result = await window.maka.voice.finishCapture(operation.id, audio);
      if (result.kind === 'transcript') {
        input.appendTranscript(operation.draftKey, result.text);
        operationRef.current = undefined;
        setCaptureState('idle');
        return;
      }
      setCaptureState('native_ready');
    } catch (error) {
      operationRef.current = undefined;
      await window.maka.voice.cancel(operation.id).catch(() => {});
      setCaptureState('idle');
      input.onError(error);
    }
  }

  async function sendNative(): Promise<void> {
    const operation = operationRef.current;
    if (!operation || operation.route.kind !== 'native_audio_task') return;
    setCaptureState('sending');
    try {
      const sent = await input.sendNativeVoice(operation.id);
      if (!sent) {
        setCaptureState('native_ready');
        return;
      }
      operationRef.current = undefined;
      setCaptureState('idle');
    } catch (error) {
      setCaptureState('native_ready');
      input.onError(error);
    }
  }

  function cancelCapture(): void {
    const operation = operationRef.current;
    operationRef.current = undefined;
    activeCaptureRef.current?.cancel();
    activeCaptureRef.current = undefined;
    if (operation) void window.maka.voice.cancel(operation.id).catch(() => {});
    setCaptureState('idle');
  }

  async function toggleRealtime(): Promise<void> {
    if (realtimeRef.current || realtimeState !== 'idle') {
      closeRealtime();
      return;
    }
    const revision = realtimeRevisionRef.current + 1;
    realtimeRevisionRef.current = revision;
    setRealtimeState('connecting');
    let sessionId: string | undefined;
    let peer: RTCPeerConnection | undefined;
    let stream: MediaStream | undefined;
    let audio: HTMLAudioElement | undefined;
    try {
      const session = await window.maka.voice.createRealtimeSession();
      sessionId = session.sessionId;
      if (revision !== realtimeRevisionRef.current) {
        await window.maka.voice.closeRealtimeSession(session.sessionId);
        return;
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      peer = new RTCPeerConnection();
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.dataset.makaVoiceAudio = 'true';
      audio.hidden = true;
      document.body.append(audio);
      peer.addEventListener('track', (event) => {
        if (audio) audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      });
      const channel = peer.createDataChannel('oai-events');
      channel.addEventListener('message', (event) => {
        void handleRealtimeEvent(channel, event.data);
      });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const response = await fetch(session.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.clientSecret}`,
          'Content-Type': 'application/sdp',
          'OpenAI-Beta': 'realtime=v1',
        },
        body: offer.sdp ?? '',
      });
      if (!response.ok) throw new Error('voice_realtime_connect_failed');
      await peer.setRemoteDescription({
        type: 'answer',
        sdp: await response.text(),
      });
      if (revision !== realtimeRevisionRef.current) {
        peer.close();
        stream.getTracks().forEach((track) => track.stop());
        audio.remove();
        await window.maka.voice.closeRealtimeSession(session.sessionId);
        return;
      }
      realtimeRef.current = {
        sessionId: session.sessionId,
        peer,
        stream,
        audio,
        channel,
      };
      peer.addEventListener('connectionstatechange', () => {
        if (peer?.connectionState === 'failed' || peer?.connectionState === 'closed') {
          closeRealtime();
        }
      });
      setProviderLabel(session.providerLabel);
      setRouteKind('realtime_voice');
      setRealtimeState('connected');
    } catch (error) {
      peer?.close();
      stream?.getTracks().forEach((track) => track.stop());
      audio?.remove();
      if (sessionId) await window.maka.voice.closeRealtimeSession(sessionId).catch(() => {});
      if (revision === realtimeRevisionRef.current) setRealtimeState('idle');
      input.onError(error);
    }
  }

  function closeRealtime(): void {
    realtimeRevisionRef.current += 1;
    const active = realtimeRef.current;
    realtimeRef.current = undefined;
    active?.channel.close();
    active?.peer.close();
    active?.stream.getTracks().forEach((track) => track.stop());
    active?.audio.remove();
    if (active) void window.maka.voice.closeRealtimeSession(active.sessionId).catch(() => {});
    setRealtimeState('idle');
  }

  async function handleRealtimeEvent(channel: RTCDataChannel, raw: unknown): Promise<void> {
    if (typeof raw !== 'string') return;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type !== 'response.function_call_arguments.done') return;
    const callId = typeof event.call_id === 'string' ? event.call_id : '';
    const name = typeof event.name === 'string' ? event.name : '';
    let args: unknown = {};
    if (typeof event.arguments === 'string') {
      try {
        args = JSON.parse(event.arguments);
      } catch {
        args = {};
      }
    }
    let output: unknown;
    try {
      const call = await window.maka.voice.validateCoordinatorToolCall({
        name,
        arguments: args,
      });
      output = await input.runCoordinatorTool(call);
    } catch (error) {
      output = {
        ok: false,
        error: error instanceof Error ? error.message : 'voice_coordinator_tool_failed',
      };
    }
    if (channel.readyState !== 'open' || !callId) return;
    channel.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(output),
        },
      }),
    );
    channel.send(JSON.stringify({ type: 'response.create' }));
  }

  return {
    captureState,
    realtimeState,
    providerLabel,
    routeKind,
    toggleCapture,
    cancelCapture,
    toggleRealtime,
  };
}
