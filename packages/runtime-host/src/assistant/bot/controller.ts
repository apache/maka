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

import type { TurnOrigin } from '@maka/core/turn-origin';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ASSISTANT_BACKGROUND_SESSION_LABEL } from '@maka/core/session';
import type { MessageContent } from '@maka/core/events';
import type { AssistantModuleServices } from '../service.js';
import type { InitiativeStore } from '../index-initiative/store.js';
import { BotStore, type InboxInput } from './store.js';

const UNREAD_SLEEP_FEEDBACK =
  '本次未能休眠：你读取 Inbox 后又收到新消息，或上一批还有未投递消息。请调用 InboxCheck 接收正文，再自行决定如何处理；不要求回复或完成每件事，之后可再次调用 Sleep。';

export class BotController {
  readonly abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private flushing?: Promise<void>;
  private activeAgent?: any;
  private deliveredThrough = 0;
  private deliveries = new Map<string, ReturnType<BotStore['batch']>>();
  checkInbox(callId: string, limit: number) {
    this.ready();
    const previous = this.deliveries.get(callId);
    if (previous) return previous;
    const batch = this.store.batch(this.deliveredThrough, limit);
    this.deliveredThrough = batch.through;
    this.deliveries.set(callId, batch);
    return batch;
  }
  isWorking() {
    return !!this.activeAgent && !this.store.get('sleepTurn') && !this.store.get('error');
  }
  isSleeping() {
    return (
      !this.running &&
      !this.store.get('error') &&
      this.store.head() <= (this.store.get<number>('deliveredThrough') ?? 0)
    );
  }
  constructor(
    readonly ctx: AssistantModuleServices,
    readonly binding: InitiativeStore,
    readonly store: BotStore,
  ) {}
  owner() {
    return this.binding.get()?.sessionId as string | undefined;
  }
  worker() {
    return this.store.get<string>('worker');
  }
  invocation(sessionId = this.owner()!) {
    return {
      sessionId,
      cwd: this.binding.get().cwd,
      emitOutput: () => {},
      turnId: 'assistant-bot',
      toolCallId: randomUUID(),
      abortSignal: this.abort.signal,
    };
  }
  start() {
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
    this.tick();
  }
  ready() {
    this.abort.signal.throwIfAborted();
    this.binding.fence();
  }
  post(input: InboxInput) {
    this.ready();
    this.store.post(input);
    this.tick();
  }
  async receive(
    id: string,
    content: MessageContent,
    origin?: Extract<TurnOrigin, { kind: 'external_connector' }>,
  ) {
    this.ready();
    this.store.post(
      {
        id,
        type: 'user_message',
        source: origin ? 'external_connector' : 'user',
        content: origin ? { ...content, origin } : content,
      },
      {
        ...content,
        type: 'user',
        ...(origin ? { origin } : {}),
        id,
        turnId: `assistant-input:${id}`,
        ts: Date.now(),
      },
    );
    await this.flush();
    this.tick();
  }
  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      if (this.store.pendingVisible().length) await this.flush();
      return;
    }
    this.flushing = (async () => {
      for (const message of this.store.pendingVisible()) {
        this.ready();
        if (!this.ctx.appendConversation)
          throw Error('Assistant conversation transport unavailable');
        await this.ctx.appendConversation(this.owner()!, message);
        this.store.delivered(message.id);
      }
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }
  async agent() {
    return this.ctx.agents.withInvocation(this.invocation(), async () => {
      let id = this.worker();
      if (!id) {
        const label = `assistant-bot:${this.owner()}`;
        const matches = (await this.ctx.sessionQuery.list()).filter((s: any) =>
          s.labels?.includes(label),
        );
        if (matches.length > 1)
          throw Error('Multiple Bot workers found; cannot choose a conversation');
        id = matches[0]?.id;
        if (!id)
          id = (
            await this.ctx.agents.create({
              background: true,
              name: '个人助手 · Bot',
              labels: [label, ASSISTANT_BACKGROUND_SESSION_LABEL],
            })
          ).sessionId;
        this.store.set('worker', id);
      }
      return this.ctx.agents.resume({ sessionId: id! });
    });
  }
  tick() {
    if (this.running || this.abort.signal.aborted || !this.owner()) return;
    try {
      this.ready();
    } catch {
      return;
    }
    const attemptedThrough = this.store.head();
    this.running = this.run()
      .catch((error) => {
        if (!this.abort.signal.aborted) {
          this.store.transaction(() => {
            this.store.set('error', String(error));
            // Mail arriving during a failed execution must still trigger a new
            // attempt. Do not latch the failure against that newer input.
            this.store.set('errorThrough', attemptedThrough);
          });
        }
      })
      .finally(() => {
        this.running = undefined;
      });
  }
  private async run() {
    await this.flush();
    if (this.store.get('error')) {
      const errorThrough = this.store.get<number>('errorThrough');
      if (errorThrough !== undefined && this.store.head() <= errorThrough) return;
      // Older versions persisted an error without an input boundary. Reconcile
      // once on recovery; subsequent failures wait for fresh input, not a timer storm.
      this.store.set('error', null);
    }
    if (this.store.head() <= (this.store.get<number>('deliveredThrough') ?? 0)) {
      this.store.set('wake', null);
      this.store.set('wakeError', null);
      return;
    }
    // Commit delivery only at a normal Sleep boundary. An interrupted loop may
    // replay mail, but cannot lose it between a tool return and durable history.
    this.deliveredThrough = this.store.get<number>('deliveredThrough') ?? 0;
    this.deliveries.clear();
    const agent = await this.agent();
    this.activeAgent = agent;
    try {
      const snapshot: any = await agent.snapshot();
      const status = snapshot?.agent?.status;
      if (
        status === 'waiting_for_user' ||
        snapshot?.pendingInteractions > 0 ||
        (status === 'blocked' && snapshot?.pendingInteractions !== 0)
      )
        throw Error('Bot requires attention in its worker Session');
      let wake = this.store.get<{ messageId: string; text: string }>('wake');
      if (wake || status !== 'running') {
        if (!wake) {
          this.store.set('sleepTurn', null);
          wake = {
            messageId: randomUUID(),
            text: `Inbox 有新消息。当前 UTC 时间：${new Date().toISOString()}。用 InboxCheck 批量接收新消息正文，自主决定如何处理；不需要轮询。`,
          };
          // Persist before submission: an ambiguous response must not create another wake.
          this.store.set('wake', wake);
        }
        for (;;) {
          this.ready();
          let resolution: any;
          try {
            resolution = await agent.messageExecution(wake.messageId);
            if (resolution?.state === 'not_admitted') {
              const admitted: any = await agent.followup(wake.text, { messageId: wake.messageId });
              if (!['turn_started', 'followup'].includes(admitted?.disposition))
                throw Error('Bot wake was not admitted');
              if (admitted.disposition === 'turn_started') {
                this.store.set('wakeError', null);
                break;
              }
            }
          } catch (error) {
            // Retry reconciliation on the next scheduler tick, keeping the submission identity.
            this.store.set('wakeError', String(error));
            return;
          }
          this.store.set('wakeError', null);
          if (resolution?.state === 'owned') {
            const current: any = await agent.snapshot();
            const currentStatus = current?.agent?.status;
            if (
              !this.store.get('sleepTurn') &&
              (['idle', 'active', 'aborted'].includes(currentStatus) ||
                (currentStatus === 'blocked' && current?.pendingInteractions === 0))
            ) {
              // An admitted wake can outlive its interrupted execution. Keep its
              // history, but persist a fresh identity before resuming unread mail.
              wake = { ...wake, messageId: randomUUID() };
              this.store.set('wake', wake);
              continue;
            }
            break;
          }
          // Pending submissions may deliberately be omitted from query results.
          if (!resolution) {
            await delay(1000, undefined, { signal: this.abort.signal });
            continue;
          }
          if (resolution?.state === 'cancelled') {
            this.store.set('wake', null);
            throw Error('Bot wake was cancelled; Inbox is preserved');
          }
          if (!['pending', 'not_admitted'].includes(resolution?.state))
            throw Error('Unexpected Bot wake execution state: ' + resolution?.state);
          await delay(1000, undefined, { signal: this.abort.signal });
        }
      }
      try {
        await agent.whenIdle(this.abort.signal);
      } catch (error) {
        // A failed execution is terminal; a failed observation is not.
        if (!this.abort.signal.aborted) {
          const stopped: any = await agent.snapshot();
          if (
            ['active', 'idle', 'aborted'].includes(stopped?.agent?.status) ||
            (stopped?.agent?.status === 'blocked' && stopped?.pendingInteractions === 0)
          )
            this.store.set('wake', null);
        }
        throw error;
      }
      const finalStatus = ((await agent.snapshot()) as any)?.agent?.status;
      this.store.set('wake', null);
      if (['aborted', 'blocked', 'waiting_for_user'].includes(finalStatus))
        throw Error('Bot stopped: ' + finalStatus);
      if (!this.store.get('sleepTurn'))
        throw Error('Bot ended without Sleep; send a new message to retry');
    } finally {
      this.activeAgent = undefined;
    }
  }
  sleep(turnId: string) {
    this.ready();
    if (this.store.head() > this.deliveredThrough) {
      this.store.set('sleepTurn', null);
      return { sleeping: false, notice: UNREAD_SLEEP_FEEDBACK };
    }
    this.store.transaction(() => {
      this.store.set('sleepThrough', this.deliveredThrough);
      this.store.set('sleepTurn', turnId);
    });
    return {
      sleeping: true,
      notice: '本轮停止工作；新消息将唤醒你。已投递消息仍可回查，不会因未回复而重复唤醒。',
    };
  }
  beforeFinish(turnId: string) {
    this.ready();
    if (
      this.store.get('sleepTurn') === turnId &&
      this.store.head() <= (this.store.get<number>('sleepThrough') ?? 0)
    ) {
      this.store.set('deliveredThrough', this.deliveredThrough);
      return { allow: true as const };
    }
    this.store.set('sleepTurn', null);
    return {
      allow: false as const,
      feedback:
        this.store.head() > this.deliveredThrough
          ? UNREAD_SLEEP_FEEDBACK
          : '你是 Inbox 驱动的 Bot。普通文本不会发送给用户，也不会让你休眠。需要交流用 SendUser，无需继续时调用 Sleep。若 Inbox 还有未投递消息，用 InboxCheck 接收正文后自行决定如何处理；读取不要求回复或完成事情。',
    };
  }
  async close() {
    clearInterval(this.timer);
    this.abort.abort(Error('Assistant Bot stopped'));
    if (this.activeAgent) await this.activeAgent.cancel();
    await Promise.allSettled([this.running, this.flushing].filter(Boolean));
  }
}
