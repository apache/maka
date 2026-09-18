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

import { randomUUID } from 'node:crypto';
import type { VoiceQueueItem, VoiceDeliveryInput, WorkHubVoiceState } from '@maka/runtime-host/protocol';

/** Single-item consumer of approved prepared speech; native replies remain independent. */
export class WorkHubVoiceOutlet {
  private stopped = false;
  private running = false;
  private blockedDelivery?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly attempted = new Set<string>();
  constructor(private readonly options: {
    callId: string;
    interval?: number;
    read(): Promise<WorkHubVoiceState>;
    record(input: VoiceDeliveryInput): Promise<WorkHubVoiceState>;
    canSend(itemId: string): boolean;
    sendReply?(text: string, requestId: string, deliveryId: string): Promise<void>;
    snapshot?(state: WorkHubVoiceState): void;
    intentRevision(): number;
    send(text: string, current: () => boolean, reserve: () => Promise<boolean>, deliveryId: string): Promise<boolean>;
    onError(message: string): void;
    onUncertain?(deliveryId: string): void;
  }) {}

  start(): void { void this.poll(); }
  close(): void { this.stopped = true; clearTimeout(this.timer); }

  private async poll(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      // Reading and delivery-state writes use fast independent Host operations.
      const readRevision = this.options.intentRevision();
      const state = await this.options.read();
      if (this.stopped) return;
      this.options.snapshot?.(state);
      // Native delegation results return immediately; voice owns conversational timing.
      // They never enter the supplemental list or its idle admission fence.
      for (const item of state.responses ?? []) {
        if (this.stopped) return;
        if (item.reply?.callId !== this.options.callId || this.attempted.has(item.id)) continue;
        const delivery = { ...item, deliveryId: randomUUID(), callId: this.options.callId };
        const reserved = await this.record(delivery, 'reserved');
        if (!reserved.deliveries.some(d => d.deliveryId === delivery.deliveryId && d.status === 'reserved')) continue;
        this.attempted.add(item.id);
        try {
          if (!this.options.sendReply) throw new Error('Native reply transport unavailable');
          await this.options.sendReply(item.text, item.reply.id, delivery.deliveryId);
          await this.record(delivery, 'sent');
        } catch (error) {
          await this.record(delivery, 'uncertain').catch(() => {});
          this.options.onError(`Native voice reply could not be confirmed: ${String(error)}`);
        }
      }
      const blocked = state.deliveries.find(item => !item.reply && item.callId === this.options.callId && (item.status === 'reserved' || item.status === 'uncertain'));
      if (blocked && blocked.deliveryId !== this.blockedDelivery) {
        this.options.onError(`Voice delivery ${blocked.id} is ${blocked.status}; it will not be replayed automatically. Review its delivery evidence in WorkHub.`);
      }
      this.blockedDelivery = blocked?.deliveryId;
      if (blocked) return;
      if (this.stopped || readRevision !== this.options.intentRevision()) return;
      const candidate = state.queue?.find(item => !this.attempted.has(item.id) &&
        !state.deliveries?.some(delivery => delivery.id === item.id) && this.options.canSend(item.id));
      if (!candidate || !this.options.canSend(candidate.id)) return;
      const item = { ...candidate };
      const revision = this.options.intentRevision();
      const delivery = { ...item, deliveryId: randomUUID(), callId: this.options.callId };
      let reserved = false;
      // Once claimed, priority edits cannot revoke this frozen item. New user intent still can.
      const current = () => !this.stopped && this.options.canSend(item.id) && revision === this.options.intentRevision();
      try {
        const sent = await this.options.send(item.text, current, async () => {
          if (!current() || !this.options.canSend(item.id)) return false;
          const result = await this.record({ ...delivery, expectedQueue: state.queue }, 'reserved');
          reserved = Boolean(result.deliveries?.some(d => d.id === item.id && d.deliveryId === delivery.deliveryId && d.callId === this.options.callId && d.status === 'reserved'));
          return reserved;
        }, delivery.deliveryId);
        if (!sent) {
          if (reserved) await this.record(delivery, 'release');
          return;
        }
        this.attempted.add(item.id);
        await this.record(delivery, 'sent');

      } catch (error) {
        // An uncertain append must not be replayed after timeout/reconnect.
        this.attempted.add(item.id);

        if (reserved) await this.record(delivery, 'uncertain').catch(() => {});
        this.options.onUncertain?.(delivery.deliveryId);
        throw error;
      }
    } catch {
      if (!this.stopped) this.options.onError('Could not read or deliver a voice queue item. Check WorkHub.');
    } finally {
      this.running = false;
      if (!this.stopped) this.timer = setTimeout(() => void this.poll(), this.options.interval ?? 250);
    }
  }

  private record(input: Omit<VoiceDeliveryInput, 'status'>, status: VoiceDeliveryInput['status']): Promise<WorkHubVoiceState> {
    return this.options.record({ ...input, status });
  }
}
