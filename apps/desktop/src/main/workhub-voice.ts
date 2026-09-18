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

import { WorkHubVoiceOutlet } from './workhub-voice-outlet.js';
import { WorkHubVoiceCallController } from './workhub-voice-call-controller.js';
import { WorkHubVoiceJev, type evaluateVoice } from './workhub-voice-jev.js';
import { WorkHubVoiceLogWriter } from './workhub-voice-log-writer.js';
import { setTimeout as wait } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { compactVoiceLogEvent } from './workhub-voice-log.js';
import { getWorkHubVoiceProvider, type WorkHubVoiceProvider, type WorkHubVoiceProviderOptions, type WorkHubVoiceSession } from './workhub-voice-provider.js';

import type { IpcMain, WebContents } from 'electron';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';

import { RuntimeHostSessionProjector, createRuntimeHostSessionProjectionSeed } from '@maka/runtime-host/adapter';
import type { DesktopRuntimeHostClient, DesktopRuntimeHostSession } from './runtime-host-client.js';
import { armVoiceMicrophone } from './main-window-permission-policy.js';

// Hash structured identity fields so native IDs cannot exceed the wire ID limit.
const voiceRecordId = (...parts: Array<string | number>): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Desktop-owned media adapter, bound to one Runtime Host candidate/owner. */
export function registerWorkHubVoice(client: DesktopRuntimeHostClient, ipc: Pick<IpcMain, 'handle'>, options: { evaluateJev?: typeof evaluateVoice; provider?: WorkHubVoiceProvider } = {}): () => void {
  let active: { id: string; owner: WebContents; manager: WorkHubVoiceSession; playback(event: Record<string, unknown>): void; abort: AbortController } | undefined;
  let armed: WebContents | undefined;
  let preparedProvider: WorkHubVoiceProvider | undefined;
  let armTimeout: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => { if (armed) armVoiceMicrophone(armed, false); armed = undefined; preparedProvider = undefined; clearTimeout(armTimeout); };
  const close = () => { const call = active; active = undefined; disarm(); call?.manager.close(); };
  ipc.handle('workhub:voice:prepare', event => {
    if (active) throw new Error('A voice call is already active');
    disarm();
    const provider = options.provider ?? getWorkHubVoiceProvider();
    if (!provider) throw new Error('No voice provider is installed. Install a voice provider before starting a call.');
    preparedProvider = provider;
    armVoiceMicrophone(event.sender, true);
    armed = event.sender;
    armTimeout = setTimeout(disarm, 60_000);
    return { providerId: provider.id, dataChannelLabel: provider.dataChannelLabel };
  });
  ipc.handle('workhub:voice:connect', async (event, input: unknown) => {
    if (active || armed !== event.sender) throw new Error('Voice capture was not prepared');
    if (!input || typeof input !== 'object') throw new Error('Invalid voice offer');
    const { id, sdp } = input as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(id) || typeof sdp !== 'string' || sdp.length > 128_000 || !sdp.startsWith('v=0')) throw new Error('Invalid voice offer');
    const provider = preparedProvider;
    if (!provider) throw new Error('Voice provider is no longer available');
    const abort = new AbortController();
    let observation: DesktopRuntimeHostSession | undefined;
    let outlet: WorkHubVoiceOutlet | undefined;
    const owner = event.sender;
    const send = (out: Record<string, unknown>) => { if (!owner.isDestroyed()) owner.send('workhub:voice:event', { id, event: out }); };
    const destroyed = () => close();
    let callController: WorkHubVoiceCallController | undefined;
    let review: WorkHubVoiceLogWriter | undefined;
    let jev: WorkHubVoiceJev | undefined;
    const recordEvent = (kind: string, data: Record<string, unknown>) => {
      const fact = compactVoiceLogEvent(kind, data);
      if (!fact) return;
      kind = fact.kind; data = fact.data;
      if (['delegation','delegation_receipt','task_result','delivery_uncertain'].includes(kind)) jev?.fact(randomUUID(), { kind, ...data });
      const eventId = randomUUID();
      const observedAt = Date.now();
      const text = JSON.stringify(data);
      if (text.length <= 12000) review?.record({ id: eventId, kind, data: { observedAt, ...data } });
      else for (let offset = 0; offset < text.length; offset += 12000)
        review?.record({ id: `${eventId}-${offset}`, kind: `${kind}_part`, data: { observedAt, eventId, offset, totalChars: text.length, content: text.slice(offset, offset + 12000) } });
    };
    let factWrites: Promise<void> = Promise.resolve();
    const pendingFacts = new Map<string, import('@maka/runtime-host/protocol').WorkHubVoiceTranscriptInput>();
    const persistFacts = () => {
      factWrites = factWrites.catch(() => {}).then(async () => {
        for (const [key, item] of pendingFacts) {
          await client.recordWorkHubVoiceTranscript(item);
          pendingFacts.delete(key);
        }
      });
      return factWrites;
    };
    const cleanup = () => {
      outlet?.close();
      jev?.close();
      recordEvent('call_closed', { callId: id });
      callController?.close(); void review?.close().catch(error => console.warn('[voice-log-close]', String(error)));
      void persistFacts().catch(error => console.warn('[voice-facts-close]', String(error)));
      abort.abort();
      owner.removeListener('destroyed', destroyed);
      void observation?.close().catch(() => undefined);
      send({ type: 'maka.closed' });
      if (active?.id === id) { active = undefined; disarm(); }
    };
    const workAdmissions = new Map<string, Promise<{ status: 'accepted' | 'rejected'; turnId?: string; reason?: string }>>();
    const voiceRequests = new Map<string, ReturnType<DesktopRuntimeHostClient['registerWorkHubVoiceRequest']>>();
    const registerRequest = (requestId: string, userTurnId: string) => {
      let pending = voiceRequests.get(requestId);
      if (!pending) {
        pending = client.registerWorkHubVoiceRequest({ id: requestId, callId: id, userTurnId });
        voiceRequests.set(requestId, pending);
        // Admission or review awaits this promise and reports failures through its normal path.
        void pending.catch(() => {});
      }
      return pending;
    };
    const submitWork: WorkHubVoiceProviderOptions['submit'] = (text, turnId = randomUUID(), displayText, _kind, userTurnId = turnId) => {
      const prior = workAdmissions.get(turnId);
      if (prior) return prior;
      const admitted = (async () => {
        if (abort.signal.aborted) return { status: 'rejected' as const, reason: 'Voice call ended' };
        await persistFacts();
        await registerRequest(turnId, userTurnId);
        const requestText = `Voice delegation (requestId: ${turnId})\n${text}`;
        const result = await client.answerWorkHubCoordination({ turnId, text: requestText,
          ...(displayText !== undefined ? { displayText } : {}), source: 'voice' });
        return { status: 'accepted' as const, turnId: result.turnId };
      })();
      // Keep both accepted and uncertain admissions: never replay an uncertain effect.
      workAdmissions.set(turnId, admitted);
      return admitted;
    };
    const observe = (entry: Record<string, unknown>) => {
      if (!abort.signal.aborted) {
        callController?.add(entry);
        const wire = entry.kind === 'transport' ? entry.event as Record<string, unknown> : undefined;
        if (wire) send({ type: 'maka.observation', event: wire });
        if (wire?.type === 'turn.created' || wire?.type === 'input_audio_buffer.speech_started') jev?.invalidate();
        if (wire?.type === 'turn.done') void jev?.tick();
      }
    };
    const enqueueOutput = async (sourceId: string, text: string, kind: 'question' | 'failure', turnId?: string) => {
      if (abort.signal.aborted) return;
      if (turnId && voiceRequests.has(turnId))
        await client.enqueueWorkHubVoice({ id: sourceId, text, kind, requestId: turnId });
    };
    const voice = provider.create({
      submit: submitWork,
      observe,
      record: recordEvent,
      onClose: cleanup,
      onError: message => send({ type: 'maka.error', message }),
    });
    const uncertainDelivery = async (deliveryId: string) => {
      const state = await client.readWorkHubVoiceState();
      const delivery = state.deliveries.find(d => d.deliveryId === deliveryId && d.callId === id);
      if (!delivery) return;
      if (delivery.status === 'sent' || delivery.status === 'reserved')
        await client.recordWorkHubVoiceDelivery({ ...delivery, status: 'uncertain' });
      review?.record({ id: `uncertain-${deliveryId}`, kind: 'delivery_uncertain', data: { deliveryId, itemId: delivery.id } });
    };
    callController = new WorkHubVoiceCallController({
      deliveryUncertain: deliveryId => { void uncertainDelivery(deliveryId).catch(error => send({ type: 'maka.state_warning', message: String(error) })); },
      callId: id,
      recordTranscript: item => {
        pendingFacts.set(item.id, item);
        jev?.fact(item.id, { kind: 'transcript', ...item });
        void persistFacts();
        void factWrites.catch(error => send({ type: 'maka.state_warning', message: `Could not persist voice evidence: ${String(error)}` }));
      },
      recordLog: entry => review?.record(entry),
      interruption: item => {
        review?.record({ id: voiceRecordId('interruption', id, JSON.stringify(item)), kind: 'interruption', data: { ...item } });
        jev?.fact(`interruption-${item.userTurnId}`, { kind: 'interruption', ...item });
      },
      onError: message => send({ type: 'maka.state_warning', message }),
    });
    review = new WorkHubVoiceLogWriter({
      callId: id,
      write: input => client.observeWorkHubVoice(input),
      onError: message => send({ type: 'maka.state_warning', message }),
    });
    jev = new WorkHubVoiceJev({
      callId: id,
      evaluate: options.evaluateJev,
      settled: () => !abort.signal.aborted && callController?.currentTurn?.status === 'done',
      flush: async () => { await review!.drain(); await persistFacts(); },
      write: input => client.observeWorkHubVoice(input),
      onError: message => send({ type: 'maka.state_warning', message }),
    });
    outlet = new WorkHubVoiceOutlet({
      callId: id,
      read: () => client.readWorkHubVoiceState(),
      record: input => client.recordWorkHubVoiceDelivery(input),

      sendReply: (text, requestId, deliveryId) => voice.sendReply(text, requestId, deliveryId),
      canSend: itemId => Boolean(callController?.canInject && jev?.canSend(itemId)),
      snapshot: state => {
        callController?.noteSnapshot(state);
        jev?.snapshot(state);

      },
      intentRevision: () => callController?.injectionRevision ?? 0,
      send: (text, current, reserve, deliveryId) => callController!.send(text, current, reserve, value => voice.sendSpeech(value, deliveryId), deliveryId),
      onError: message => send({ type: 'maka.state_warning', message }),
      onUncertain: deliveryId => { void uncertainDelivery(deliveryId).catch(error => send({ type: 'maka.state_warning', message: String(error) })); },
    });
    const manager = voice;
    active = { id, owner, manager, abort, playback: event => observe({ kind: 'transport', event }) };
    clearTimeout(armTimeout);
    owner.once('destroyed', destroyed);
    try {
      await client.resolveWorkHubCoordinationSession();
      observation = await client.openSession(WORKHUB_COORDINATION_SESSION_ID);
      if (abort.signal.aborted) { await observation.close(); throw new Error('Voice call ended'); }
      review.record({ id: randomUUID(), kind: 'call_started', data: { callId: id } });
      await review.drain();
      void (async () => {
        let retryDelay = 250;
        while (!abort.signal.aborted) {
          try {
            if (!observation) observation = await client.openSession(WORKHUB_COORDINATION_SESSION_ID);
            if (abort.signal.aborted) { await observation.close(); return; }
            const history = await observation.loadTranscript();
            const projector = new RuntimeHostSessionProjector(observation.snapshot,
              createRuntimeHostSessionProjectionSeed(history, observation.snapshot), Date.now, observation.activeAssistantStreams);
            for await (const frame of observation.events) {
              if (abort.signal.aborted) return;
              retryDelay = 250;
              const update = projector.accept(frame);
              for (const item of update.events) {
                if (item.type === 'user_question_request')
                  await enqueueOutput(item.id, item.questions.map(q => q.question).join(' '), 'question', item.turnId);
                if (item.type === 'form_request')
                  await enqueueOutput(item.id, `${item.message}. The form is available in WorkHub.`, 'question', item.turnId);
              }
              if (update.terminalTurn?.status === 'failed')
                send({ type: 'maka.error', message: update.terminalTurn.failureMessage ?? 'WorkHub could not complete its current turn.' });
            }
            if (!abort.signal.aborted) throw new Error('WorkHub session subscription ended');
          } catch (error) {
            if (abort.signal.aborted) return;
            if (retryDelay === 250) send({ type: 'maka.state_warning', message: `WorkHub observation interrupted; reconnecting. ${String(error)}` });
          }
          await observation?.close().catch(() => undefined);
          observation = undefined;
          await wait(retryDelay, undefined, { signal: abort.signal }).catch(() => {});
          retryDelay = Math.min(retryDelay * 2, 5000);
        }
      })().catch(error => { if (!abort.signal.aborted) send({type: 'maka.state_warning',message: String(error)}); });
      const answer = await voice.connect(sdp);
      try {
        const state = await client.readWorkHubVoiceState();
        if (!abort.signal.aborted) { callController?.noteSnapshot(state); }
      } catch {
        send({ type: 'maka.state_warning', message: 'Could not restore voice continuity. The call can continue.' });
      }
      if (!abort.signal.aborted) outlet.start();
      return answer;
    } catch (error) { manager.close(); throw error; }
  });
  ipc.handle('workhub:voice:event', (event, id, message) => {
    if (!active || active.id !== id || active.owner !== event.sender) return;
    if (!message || typeof message !== 'object' || JSON.stringify(message).length > 500_000) return;
    if (message.type === 'maka.audio_activity') {
      // Playback evidence is host-owned, not a provider wire message.
      active.playback(message);
    } else active.manager.accept(message);
  });
  ipc.handle('workhub:voice:disconnect', (event, id) => {
    if (active?.owner === event.sender && active.id === id) close();
    else if (!active && armed === event.sender) disarm();
  });
  return close;
}
