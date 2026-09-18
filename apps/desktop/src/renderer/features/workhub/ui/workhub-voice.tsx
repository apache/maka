/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useEffect, useRef, useState } from 'react';
import { VoiceTranscriptCollector, type VoiceTranscript } from '../model/voice-transcript.js';
import { Mic, MicOff, Phone, PhoneOff } from '@maka/ui/icons';
import { Button, IconButton } from '@astryxdesign/core';
import type { UiLocale } from '@maka/core/ui-locale';
import { workHubVoiceCopy } from '../locales/workhub-voice-copy.js';
import type { WorkHubVoiceBridge } from '../../../../shared/workhub-voice.js';

type Call = { id: string; sessionId: string; peer: RTCPeerConnection; stream?: MediaStream; audio: HTMLAudioElement; unsubscribe: () => void; timeout?: ReturnType<typeof setTimeout>; captionTimer?: ReturnType<typeof setTimeout>; caption?: VoiceTranscript; closed: boolean; audioContext?: AudioContext; meter?: ReturnType<typeof setInterval> };
export function WorkHubVoice({ bridge, sessionId, enabled, locale, onTranscript }: { bridge: WorkHubVoiceBridge; sessionId?: string | null; enabled: boolean; locale: UiLocale; onTranscript?: (value: VoiceTranscript | undefined) => void }) {
  const t = workHubVoiceCopy[locale];
  const current = useRef<Call | undefined>(undefined);
  const transcriptListener = useRef(onTranscript);
  transcriptListener.current = onTranscript;
  const [phase, setPhase] = useState<'idle' | 'setup' | 'connecting' | 'live'>('idle');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');

  const end = (call = current.current) => {
    if (!call || call.closed) return;
    call.closed = true;
    clearTimeout(call.timeout);
    clearTimeout(call.captionTimer);
    call.unsubscribe();
    call.stream?.getTracks().forEach(track => track.stop());
    call.peer.close();
    clearInterval(call.meter);
    void call.audioContext?.close().catch(() => undefined);
    call.audio.pause();
    call.audio.srcObject = null;
    void bridge.disconnect(call.sessionId, call.id).catch(() => undefined);
    if (current.current === call) { transcriptListener.current?.(undefined); current.current = undefined; setPhase('idle'); setMuted(false); }
  };
  useEffect(() => () => end(current.current), [bridge, sessionId]);
  const start = async () => {
    if (!sessionId || current.current) return;
    setError(''); setPhase('connecting');
    const call: Call = { id: crypto.randomUUID(), sessionId, peer: new RTCPeerConnection(), audio: new Audio(), unsubscribe: () => {}, closed: false };
    current.current = call;
    call.timeout = setTimeout(() => { setError(t.serviceError); end(call); }, 45_000);
    const collector = new VoiceTranscriptCollector();
    try {
      const provider = await bridge.prepare(sessionId);
      if (call.closed) { await bridge.disconnect(sessionId, call.id); return; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (call.closed) { stream.getTracks().forEach(track => track.stop()); return; }
      call.stream = stream;
      stream.getTracks().forEach(track => call.peer.addTrack(track, stream));
      call.peer.ontrack = event => {
        call.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void call.audio.play().catch(() => { setError(t.playbackError); end(call); });
        if (!call.audioContext) {
          const context = call.audioContext = new AudioContext();
          const analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          context.createMediaStreamSource(call.audio.srcObject as MediaStream).connect(analyser);
          const samples = new Float32Array(analyser.fftSize);
          let active = false;
          let lastSound = 0;
          void context.resume();
          call.meter = setInterval(() => {
            if (call.closed) return;
            analyser.getFloatTimeDomainData(samples);
            const audible = !call.audio.muted && !call.audio.paused && call.audio.volume > 0;
            const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
            if (audible && rms > 0.002) lastSound = performance.now();
            const next = audible && lastSound > 0 && performance.now() - lastSound < 1200;
            if (next === active) return;
            active = next;
            void bridge.event(sessionId, call.id, { type: 'maka.audio_activity', active }).catch(() => end(call));
          }, 100);
        }
      };
      const channel = call.peer.createDataChannel(provider.dataChannelLabel);
      const pending: Record<string, unknown>[] = [];
      call.audio.muted = false;
      call.unsubscribe = bridge.subscribe(message => {
        if (message.id !== call.id || call.closed) return;
        if (message.event.type === 'maka.state_warning') { setError(String(message.event.message || t.serviceError)); return; }
        if (message.event.type === 'maka.error') { setError(String(message.event.message || t.serviceError)); end(call); return; }
        if (message.event.type === 'maka.closed') { end(call); return; }
        if (message.event.type === 'maka.observation') {
          const transcript = collector.accept(message.event.event as Record<string, unknown>);
          if (transcript) {
            call.caption = transcript;
            call.captionTimer ??= setTimeout(() => {
              call.captionTimer = undefined;
              if (!call.closed) transcriptListener.current?.(call.caption);
            }, 100);
          }
          return;
        }
        if (channel.readyState === 'open') channel.send(JSON.stringify(message.event));
        else if (pending.length < 64) pending.push(message.event);
        else end(call);
      });
      channel.onopen = () => { if (call.closed) return; clearTimeout(call.timeout); setPhase('live'); for (const event of pending.splice(0)) channel.send(JSON.stringify(event)); };
      channel.onmessage = message => {
        if (typeof message.data !== 'string' || message.data.length > 500_000) return;
        try {
          const event = JSON.parse(message.data) as Record<string, unknown>;
          void bridge.event(sessionId, call.id, event).catch(() => end(call));
        } catch { end(call); }
      };
      channel.onclose = () => end(call);
      call.peer.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(call.peer.connectionState)) end(call); };
      const offer = await call.peer.createOffer();
      await call.peer.setLocalDescription(offer);
      const answer = await bridge.connect(sessionId, { id: call.id, sdp: offer.sdp! });
      if (call.closed) { await bridge.disconnect(sessionId, call.id); return; }
      await call.peer.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (reason) {
      if (!call.closed) setError(reason instanceof Error ? reason.message : String(reason));
      end(call);
    }
  };
  return <div className="workHubVoice">
    {phase === 'idle' || phase === 'setup' ? <IconButton type="button" size="sm" variant="ghost" icon={<Phone size={16} />} label={t.call} isDisabled={!enabled || !sessionId} onClick={() => { setPhase(phase === 'setup' ? 'idle' : 'setup'); }} /> : <>
      <span role="status">{phase === 'connecting' ? (t.connecting) : (t.live)}</span>
      <IconButton type="button" size="sm" variant="ghost" icon={muted ? <MicOff size={16} /> : <Mic size={16} />} isDisabled={phase !== 'live'} label={muted ? (t.unmute) : (t.mute)} onClick={() => { current.current?.stream?.getAudioTracks().forEach(track => { track.enabled = muted; }); setMuted(!muted); }} />
      <IconButton type="button" size="sm" variant="ghost" icon={<PhoneOff size={16} />} label={t.end} onClick={() => end()} />
    </>}
    {phase === 'setup' && <div className="workHubVoiceSetup">
      <p>{t.providerHint}</p>
      <Button type="button" label={t.start} onClick={() => void start()} />
    </div>}
    {error && <span className="workHubVoiceError" role="alert">{error}</span>}
  </div>;
}
