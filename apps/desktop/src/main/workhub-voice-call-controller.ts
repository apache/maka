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

import { WorkHubVoiceFacts } from './workhub-voice-facts.js';
import type { VoiceInterruption, VoiceLogInput, WorkHubVoiceState, WorkHubVoiceTranscriptInput } from '@maka/runtime-host/protocol';

/** Single owner of local media availability and outbound serialization. No semantic maintenance. */
export class WorkHubVoiceCallController {
  private nativeTurn?: { id: string; role: 'user' | 'assistant'; status: 'created' | 'done' };
  private readonly playing = new Set<string>();
  private readonly backendUserIds = new Set<string>();
  private readonly injectionListeners = new Set<() => void>();
  private stopped = false;
  private awaitingReply = false;
  private pendingSpeech = false;
  private uncertainDeliveryId?: string;
  private sentAtOutput = 0;
  private sentAtIntent = 0;
  private firstOutputDeadline?: ReturnType<typeof setTimeout>;
  private nativeUserId?: string;
  private intent = 0;
  private outputs = 0;
  private publishing: Promise<unknown> = Promise.resolve();
  private queued = 0;

  private readonly endedTurns = new Set<string>();
  private readonly facts: WorkHubVoiceFacts;
  constructor(private readonly options: { callId: string;
    recordLog?(entry: VoiceLogInput): void;
    recordTranscript(item: WorkHubVoiceTranscriptInput): void;
    interruption(item: VoiceInterruption): void;
    onError?(message: string): void;
    outputTimeoutMs?: number;
    deliveryUncertain?(deliveryId: string): void;
  }) {
    this.facts = new WorkHubVoiceFacts(options.callId, event => {
      if (event.kind === 'transcript') options.recordTranscript(event.item);
      else if (event.kind === 'log') options.recordLog?.(event.entry);
      else options.interruption(event.item);
    });
  }
  noteSnapshot(state: WorkHubVoiceState): void {
    while (this.backendUserIds.size > 512) this.backendUserIds.delete(this.backendUserIds.values().next().value!);
    if (this.uncertainDeliveryId && state.deliveries.some(d => d.deliveryId === this.uncertainDeliveryId && d.status === 'resolved')) this.uncertainDeliveryId = undefined;
    this.notify();
  }
  private get mediaAvailable(): boolean {
    return !this.stopped && this.nativeTurn?.status !== 'created' && !this.outputActive &&
      (!this.awaitingReply || Boolean(this.nativeUserId && this.backendUserIds.has(this.nativeUserId)));
  }
  get idle(): boolean { return this.mediaAvailable && !this.pendingSpeech; }
  get canInject(): boolean { return !this.uncertainDeliveryId && !this.pendingSpeech && this.mediaAvailable; }
  get injectionRevision(): number { return this.intent; }
  get currentTurn(): Readonly<{ id: string; role: 'user' | 'assistant'; status: 'created' | 'done' }> | undefined {
    return this.nativeTurn ? { ...this.nativeTurn } : undefined;
  }
  get outputActive(): boolean {
    return (this.nativeTurn?.role === 'assistant' && this.nativeTurn.status === 'created') || Boolean(this.playing.size);
  }
  private notify(): void { for (const listener of this.injectionListeners) listener(); }

  add(event: Record<string, unknown>): void {
    if (this.stopped) return;
    const wire = event.kind === 'transport'
      ? event.event as Record<string, unknown> : undefined;
    const nativeTurn = wire?.turn as { id?: string; role?: string } | undefined;
    const endId = wire?.type === 'turn.done' && nativeTurn?.role === 'assistant' ? nativeTurn.id : undefined;
    const userId = nativeTurn?.role === 'user' ? nativeTurn.id : undefined;
    const userEndKey = userId ? `user:${userId}` : undefined;
    const userEnded = wire?.type === 'turn.done' && userEndKey && !this.endedTurns.has(userEndKey);
    if (endId) this.endedTurns.add(endId);
    if (wire) this.facts.accept(wire, this.outputActive);
    const type = String(wire?.type ?? event.kind);
    const turn = wire?.turn as { id?: string; role?: string; transcript?: string; start_ms?: number; end_ms?: number } | undefined;
    switch (type) {
      case 'maka.audio_activity':
        if (wire?.active) {
          if (!this.playing.has('native-audio')) this.outputs++;
          this.playing.add('native-audio');
          clearTimeout(this.firstOutputDeadline);
        }
        else this.playing.delete('native-audio');
        break;
      case 'turn.created':
        if (turn?.role === 'user' && turn.id && !this.endedTurns.has(`user:${turn.id}`)) {
          this.nativeTurn = { id: turn.id, role: 'user', status: 'created' };
          this.nativeUserId = turn.id;
          this.awaitingReply = true;
          this.intent++;
        } else if (turn?.role === 'assistant' && turn.id && !this.endedTurns.has(turn.id)) {
          this.awaitingReply = false;
          this.nativeTurn = { id: turn.id, role: 'assistant', status: 'created' };
          this.outputs++;
          clearTimeout(this.firstOutputDeadline);
        }
        break;
      case 'turn.done':
        if (turn?.id && (turn.role === 'user' || turn.role === 'assistant') &&
            (!this.nativeTurn || (this.nativeTurn.id === turn.id && this.nativeTurn.role === turn.role))) {
          this.nativeTurn = { id: turn.id, role: turn.role, status: 'done' };
          if (turn.role === 'user' && userEnded) {
            this.nativeUserId = turn.id;
            this.intent++;
          }
        }
        break;
      case 'delegation_pending':
        if (typeof event.userTurnId === 'string') {
          // Delegation only records backend ownership. User completion is owned
          // by turn.done, never inferred from a handoff.
          this.backendUserIds.add(event.userTurnId);
        }
        break;
    }
    if (this.pendingSpeech && this.mediaAvailable && (this.outputs > this.sentAtOutput || this.intent > this.sentAtIntent)) {
      this.pendingSpeech = false;
      clearTimeout(this.firstOutputDeadline);
    }
    if (userEnded && userId) {
      this.endedTurns.add(userEndKey!);
    }
    this.notify();
  }

  async send(text: string, current: () => boolean, reserve: () => Promise<boolean>, send: (text: string) => Promise<void>, deliveryId?: string): Promise<boolean> {
    let accepted = false;
    await this.enqueue(async () => {
      if (!current() || !await reserve()) return;
      if (!current() || !this.canInject || this.stopped) return;
      this.pendingSpeech = true;
      this.sentAtOutput = this.outputs;
      this.sentAtIntent = this.intent;
      // This deadline covers first output only; pendingSpeech separately gates playback.
      this.firstOutputDeadline = setTimeout(() => {
        if (this.pendingSpeech) {
          if (deliveryId) { this.uncertainDeliveryId = deliveryId; this.pendingSpeech = false; this.options.deliveryUncertain?.(deliveryId); }
          this.options.onError?.('Voice output has not been observed. This delivery is uncertain and will not be replayed automatically.');
        }
      }, this.options.outputTimeoutMs ?? 30_000);
      this.firstOutputDeadline.unref?.();
      try { await send(text); accepted = true; }
      catch (error) { this.uncertainDeliveryId = deliveryId; this.pendingSpeech = false; clearTimeout(this.firstOutputDeadline); throw error; }
    }, current);
    return accepted;
  }

  private enqueue(send: () => Promise<void>, current: () => boolean): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.queued >= 32) return Promise.reject(new Error('Too many pending voice updates'));
    this.queued++;
    const operation = this.publishing.then(async () => {
      const available = () => this.canInject;
      while (!this.stopped && current()) {
        if (available()) { await send(); return; }
        await new Promise<void>(resolve => {
          const check = () => {
            if (this.stopped || !current() || available()) { this.injectionListeners.delete(check); resolve(); }
          };
          this.injectionListeners.add(check); check();
        });
      }
    }).finally(() => { this.queued--; });
    this.publishing = operation.catch(() => undefined);
    return operation;
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.firstOutputDeadline);
    this.notify();
    this.injectionListeners.clear();
  }
}
