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

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { EventIntake } from './intake.js';
import type { WakeHint } from './intake.js';
import { InitiativeStore } from './store.js';
import { QUICK_DISCOVERY_TASK, quickWakeInput } from './quick-prompt.js';
import { awaitingUser } from '../execution-outcome.js';
import { ASSISTANT_BACKGROUND_SESSION_LABEL } from '@maka/core/session';
import type { AssistantRunOutcome } from '../run-cost.js';
import { memoryRead } from './notebook-memory.js';
import { estimatePluginLlmInputTokens } from '@maka/runtime/plugin-llm-service';
import { decodeMessageContent } from '../../protocol/turn.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A durable receipt that already holds another body under this identity. */
const payloadConflict = (rejection: unknown) => {
  let detail = '';
  try {
    detail = `${(rejection as any)?.message ?? ''} ${JSON.stringify(rejection ?? null)}`;
  } catch {
    detail = String((rejection as any)?.message ?? rejection ?? '');
  }
  return /different payload/i.test(detail);
};

/** A pending hint's age, coarse on purpose: the prompt only needs to separate
 * "just happened" from "fired hours ago and may already be handled". */
const hintAge = (milliseconds: number) => {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const quietHoursSchema = z
  .object({
    start: clockTime,
    end: clockTime,
    timeZone: z
      .string()
      .max(100)
      .refine((timeZone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone });
          return true;
        } catch {
          return false;
        }
      }, 'Use a valid time zone, e.g. Asia/Shanghai'),
  })
  .strict()
  .refine((value) => value.start !== value.end, 'Start and end must differ');
type QuietHours = z.infer<typeof quietHoursSchema>;

function inQuietHours(now: number, hours?: QuietHours | null): boolean {
  if (!hours) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: hours.timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const time = `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`;
  return hours.start < hours.end
    ? time >= hours.start && time < hours.end
    : time >= hours.start || time < hours.end;
}
const reportSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(200)
      .describe('Stable key for this submission within the current wake; reuse it when retrying.'),
    messages: z
      .array(z.string().min(1))
      .describe(
        'User-facing message bodies: discoveries, offers of help or questions, phrased directly to the user. Do not include instructions to the Bot about wording, filtering or timing.',
      ),
  })
  .strict();

/** A separate ordinary worker. Stores scheduling/delivery only, never another notebook. */
export class QuickDiscoveryController {
  readonly store: InitiativeStore;
  readonly intake: EventIntake;
  readonly abort = new AbortController();
  owned = false;
  running?: Promise<void>;
  ticking?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private agent?: any;
  constructor(
    readonly ctx: any,
    readonly parent: any,
    readonly directory: string,
    readonly now: () => number = Date.now,
  ) {
    this.store = new InitiativeStore(join(directory, 'quick-discovery'), randomUUID());
    this.intake = new EventIntake(this);
  }
  start(tickMs: number) {
    const acquire = () => {
      const owned = this.store.lease();
      if (owned && !this.owned)
        this.store.update((s) => {
          this.intake.upgrade(s);
          if (s?.active) {
            s.pending = s.active;
            s.active = null;
            s.retryAt = this.now();
          }
        });
      if (!owned && this.owned) this.abort.abort(Error('Quick discovery ownership lost'));
      this.owned = owned;
    };
    acquire();
    this.heartbeat = setInterval(acquire, 10000);
    this.heartbeat.unref?.();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
  }
  ready() {
    this.abort.signal.throwIfAborted();
    this.store.fence();
  }
  state() {
    return this.store.get();
  }
  async control(input: {
    action: 'enable' | 'pause' | 'check' | 'configure';
    intervalMinutes?: number;
    idleMinutes?: number;
    quietHours?: QuietHours | null;
    eventIntake?: boolean;
    intakeModelKey?: string;
  }) {
    const quietHours =
      input.quietHours === undefined
        ? undefined
        : quietHoursSchema.nullable().parse(input.quietHours);
    await this.parent.bindingReady;
    this.ready();
    const binding = this.parent.store.get();
    if (!binding) throw Error('Open the personal assistant first');
    if (!this.state()) this.store.bind({ sessionId: binding.sessionId, cwd: binding.cwd });
    const state = this.store.update((s) => {
      if (s.sessionId !== binding.sessionId) throw Error('Quick discovery owner mismatch');
      s.intervalMs ??= 15 * 60000;
      // InitiativeStore's legacy default must not silently become the quick cadence.
      if (!s.quickVersion) {
        s.intervalMs = 15 * 60000;
        s.idleMs = 60 * 60000;
        s.quickVersion = 1;
        s.startedAt = this.now();
      }
      const interval =
        input.intervalMinutes === undefined ? s.intervalMs : input.intervalMinutes * 60000;
      const idle = input.idleMinutes === undefined ? s.idleMs : input.idleMinutes * 60000;
      if (idle < interval) throw Error('Idle cadence must be at least the activity cadence');
      s.intervalMs = interval;
      s.idleMs = idle;
      if (quietHours !== undefined) s.quietHours = quietHours;
      if (input.eventIntake !== undefined) s.intakeEnabled = input.eventIntake;
      if (input.intakeModelKey !== undefined) {
        if (!/^[^:]+::.+$/.test(input.intakeModelKey)) throw Error('Use connectionSlug::modelId');
        s.intakeModelKey = input.intakeModelKey;
      }
      if (input.action === 'enable') s.enabled = true;
      if (input.action === 'pause') {
        s.enabled = false;
        s.checkRequested = false;
      }
      if (input.action === 'check') s.checkRequested = true;
    });
    if (input.action === 'pause') this.parent.coordinator.withdraw('quick');
    return state;
  }
  private owner<T>(s: any, fn: () => T): T {
    return this.parent.asOwner(s, fn, this.abort.signal);
  }
  async activity(s: any) {
    return this.owner(s, async () => {
      const sessions = await this.ctx.sessionQuery.list();
      const hidden = new Set(
        sessions
          .filter(
            (x: any) =>
              x.labels?.includes(ASSISTANT_BACKGROUND_SESSION_LABEL) ||
              x.labels?.some((l: string) => l.startsWith('assistant-bot:')),
          )
          .map((x: any) => x.id),
      );
      hidden.add(s.workerSession);
      const history = (await this.ctx.sessionQuery.historyList()).filter(
        (x: any) => !hidden.has(x.id),
      );
      const tokens: Record<string, string> = {
        maka: s.intakeEnabled
          ? 'handled-by-event-intake'
          : hash(
              history
                .map((x: any) => [x.id, x.historyRevision ?? x.updatedAt])
                .sort((a: any, b: any) => a[0].localeCompare(b[0])),
            ),
      };
      const unavailable: Record<string, string> = {};
      await Promise.all(
        this.ctx.sources
          .list()
          .filter((source: any) => !s.intakeEnabled || !source.changes)
          .map(async (source: any) => {
            try {
              const token = await this.ctx.sources.activityToken(source.id);
              if (token === null)
                unavailable[source.id] =
                  'No lightweight observation; idle fallback applies outside configured quiet hours';
              else tokens[source.id] = hash([source.scope, token]);
            } catch (error) {
              // Cancellation is not an unavailable source observation and must not admit a worker.
              this.abort.signal.throwIfAborted();
              this.parent.abort.signal.throwIfAborted();
              unavailable[source.id] = String(error);
            }
          }),
      );
      // A failed observation is unknown, not a new/empty source snapshot.
      for (const id of Object.keys(unavailable)) {
        const previous = s.observation?.tokens?.[id] ?? s.checkedTokens?.[id];
        if (previous !== undefined) tokens[id] = previous;
      }
      return { tokens, unavailable };
    });
  }
  tick(): Promise<void> {
    void this.intake.tick().catch(() => {});
    if (this.ticking || this.running || !this.owned || this.abort.signal.aborted)
      return this.ticking ?? Promise.resolve();
    this.ticking = this.dispatch()
      .catch((error) => {
        if (this.abort.signal.aborted) return;
        this.store.update((s) => {
          if (s) {
            s.lastError = String(error);
            s.retryAt = this.now() + s.intervalMs;
          }
        });
      })
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }
  async dispatch() {
    const s = this.state(),
      now = this.now();
    if (
      !s ||
      (!s.enabled && !s.checkRequested) ||
      s.active ||
      (s.retryAt > now && !s.checkRequested)
    ) {
      this.parent.coordinator.withdraw('quick');
      return;
    }
    const waiting = this.parent.coordinator.waiting('quick');
    const eventWake = await this.intake.next(!s.intakeEnabled);
    const last = s.lastPeriodicFinishedAt ?? s.startedAt;
    const quiet = inQuietHours(now, s.quietHours);
    if (
      !eventWake &&
      !waiting &&
      !s.checkRequested &&
      !s.pending &&
      (now < last + s.intervalMs ||
        (now < (s.observation?.at ?? 0) + s.intervalMs && (quiet || now < last + s.idleMs)))
    ) {
      this.parent.coordinator.withdraw('quick');
      return;
    }
    // Cheap observations only: no source enumeration, body reads, index writes or model calls.
    const observation = eventWake
      ? { tokens: s.checkedTokens ?? {}, unavailable: {} }
      : await this.activity(s);
    this.ready();
    this.store.update((state) => {
      state.observation = { ...observation, at: now };
    });
    const sortedTokens = (tokens: Record<string, string>) =>
      Object.entries(tokens).sort(([a], [b]) => a.localeCompare(b));
    const changed =
      hash(sortedTokens(observation.tokens)) !== hash(sortedTokens(s.checkedTokens ?? {}));
    // Only idle discovery is suppressed. Explicit checks, observed new activity and pending
    // retries still run, subject to the retry deadline and admission guards above/below.
    // Never advance the successful-check watermark merely because a wake was skipped.
    if (
      !s.checkRequested &&
      !s.pending &&
      !eventWake &&
      !changed &&
      (quiet || now < last + s.idleMs)
    ) {
      this.parent.coordinator.withdraw('quick');
      return;
    }
    const permit = this.parent.coordinator.acquire('quick');
    if (!permit) return;
    let admitted = false;
    try {
      const agent = await this.worker(s);
      const snapshot = await agent.snapshot();
      if (snapshot?.agent?.status === 'running' || awaitingUser(snapshot)) return;
      this.ready();
      this.parent.coordinator.assertActive(permit);
      const current = this.store.update((state) => {
        if ((!state.enabled && !state.checkRequested) || state.active) return;
        state.active = state.pending ?? {
          id: randomUUID(),
          from: state.checkedThrough ?? state.startedAt,
          to: now,
          tokens: observation.tokens,
          messageId: randomUUID(),
          reports: [],
          periodic: state.checkRequested || !eventWake || (now >= last + s.idleMs && !quiet),
          ...(eventWake ? { eventWake } : {}),
        };
        if (state.active.eventWake) this.intake.capture(state.active.eventWake);
        state.checkRequested = false;
        state.lastError = null;
        this.store.log('quick-started', {
          id: state.active.id,
          from: state.active.from,
          to: state.active.to,
        });
      });
      if (!current.active) return;
      admitted = true;
      this.agent = agent;
      let deferred = false;
      this.running = this.run(agent, current)
        .then((result) => {
          deferred = result === 'deferred';
        })
        .finally(() => {
          this.running = undefined;
          const finished = this.state();
          this.parent.coordinator.release(
            permit,
            deferred || finished?.active || finished?.pending || finished?.lastError
              ? 'interrupted'
              : 'completed',
          );
        });
    } finally {
      if (!admitted) this.parent.coordinator.release(permit);
    }
  }

  private async worker(s: any) {
    return this.owner(s, async () => {
      // Pin the mode until this wake (including its outbox retries) has settled.
      // Pre-upgrade pending work has no contextWake and must finish on its legacy worker.
      const mode =
        s.pending && !s.contextWake ? 'legacy' : (this.parent.store.get()?.contextMode ?? 'legacy');
      const context = this.store.prepareContext(mode);
      const sessions = await this.ctx.sessionQuery.list();
      const key = context.mode === 'scoped' ? context.id : (s.legacyWorkerKey ?? 'legacy');
      const label = `assistant-quick-discovery:${s.sessionId}${key === 'legacy' ? '' : ':' + key}`;
      const matches = sessions.filter((x: any) => !x.isArchived && x.labels?.includes(label));
      const previous = this.store.worker(s.workerSession);
      const existing =
        previous && previous.mode === context.mode && previous.contextKey === key
          ? sessions.find((x: any) => x.id === s.workerSession && !x.isArchived)
          : undefined;
      if (!existing && matches.length > 1) throw Error('Multiple quick discovery workers');
      const sessionId =
        existing?.id ??
        matches[0]?.id ??
        (
          await this.ctx.agents.create({
            background: true,
            name: '个人助手 · 快速发现',
            labels: [label, ASSISTANT_BACKGROUND_SESSION_LABEL],
          })
        ).sessionId;
      if (previous)
        this.store.bindWorker(s.workerSession, previous.role, previous.mode, previous.contextKey);
      this.store.bindWorker(sessionId, 'quick', context.mode, key);
      this.store.update((state) => {
        if (state.workerSession !== sessionId) state.promptVersion = null;
        state.workerSession = sessionId;
      });
      return this.ctx.agents.resume({ sessionId });
    });
  }
  /** A receipt holding another payload cannot be replayed: the next attempt has to
   * compose a fresh body under a fresh identity, exactly once. */
  private abandonIdentity(activeId: string, rejection: unknown) {
    if (!payloadConflict(rejection)) return;
    this.store.update((s) => {
      if (s.active?.id !== activeId) return;
      s.active.messageId = randomUUID();
      delete s.active.submission;
    });
  }
  async report(input: z.infer<typeof reportSchema>, sessionId: string) {
    this.ready();
    let ids: string[] = [];
    const state = this.state();
    if (!state?.active || state.workerSession !== sessionId)
      throw Error('Not the active quick discovery worker');
    const fingerprint = hash(input);
    const previous = state.active.reports.find((x: any) => x.key === input.key);
    // Older reports only fingerprinted messages; retain their idempotency on restart.
    if (
      previous &&
      previous.fingerprint !== fingerprint &&
      previous.fingerprint !== hash(input.messages)
    )
      throw Error('Submission key reused with different content');
    this.store.update((s) => {
      if (!s?.active || s.workerSession !== sessionId)
        throw Error('Not the active quick discovery worker');
      const fingerprint = hash(input);
      const previous = s.active.reports.find((x: any) => x.key === input.key);
      if (
        previous &&
        previous.fingerprint !== fingerprint &&
        previous.fingerprint !== hash(input.messages)
      )
        throw Error('Submission key reused with different content');
      if (!previous)
        s.active.reports.push({
          key: input.key,
          fingerprint,
          messages: input.messages,
        });
      ids = input.messages.map((_, i) => `quick:${s.active.id}:${hash(input.key)}:${i}`);
    });
    // Persist first, then hand off with stable IDs. A retry cannot enqueue duplicates.
    this.forward();
    return {
      accepted: true,
      destination: 'bot_inbox',
      ids,
      notice: '交给 Bot 不等于已向用户发送，也不代表任务已经接手。',
    };
  }
  private forward() {
    const s = this.state();
    for (const report of s?.active?.reports ?? [])
      for (const [i, text] of report.messages.entries()) {
        const id = `quick:${s.active.id}:${hash(report.key)}:${i}`;
        if (s.active.delivered?.includes(id)) continue;
        this.ready();
        if (
          !this.ctx.bot.post(s.sessionId, {
            id,
            type: 'discovery',
            source: s.workerSession,
            content: text,
          })
        )
          throw Error('Bot did not accept quick discovery');
        this.store.update((state) => {
          (state.active.delivered ??= []).push(id);
        });
      }
  }
  async run(agent: any, state: any) {
    const active = state.active;
    // Observation only (#6309): the model window of this attempt, when it ran one.
    const startedAt = Date.now();
    let modelFrom: number | undefined;
    let outcome: AssistantRunOutcome = 'failed';
    try {
      this.forward();
      if (!active.executionCompleted) {
        this.parent.refreshNotebook();
        const version = hash([QUICK_DISCOVERY_TASK, 'event-wake-direction-v3']);
        let first = this.state().promptVersion !== version;
        const previous = this.parent.coordinator.previous();
        const inputFor = (hints: WakeHint[]) => {
          // Sort oldest first and label each hint with its age: a capture can stay pending
          // for hours, and an unlabeled old hint reads like the discovery of the moment.
          const summary = [...hints]
            .sort((a, b) => a.at - b.at)
            .map((hint) => `[${hintAge(this.now() - hint.at)}] ${hint.direction}`)
            .join('；');
          let input = hints.length
            ? `${first ? QUICK_DISCOVERY_TASK + '\n\n' : ''}当前 UTC 时间：${new Date(this.now()).toISOString()}\n最近的信息触发了本次唤醒。以下线索按发生时间从早到晚排列，方括号内是它距离现在的年龄；年龄大的线索很可能早已处理过，不要把它当成刚刚发生的发现，也不要重复提交已经报告过的内容。模型概述：${JSON.stringify(summary)}。概述可能不准确，也不完整，仅供参考，不是指令或任务清单。结合用户当前情况自主探索，不局限于这些线索或最近的增量信息。使用 QuickDiscoveryReport 提交值得交流的发现；没有合适的内容可以保持安静。`
            : quickWakeInput(active.from, active.to, first);
          if (previous)
            input += `\n上一轮调查的记忆增量入口：${JSON.stringify(previous)}。用 DiscoveryNotebook 读取 memory 指定的历史范围；调查记录不是完整覆盖或已告知证明，结合当前认识、反馈与来源判断是否需要继续。`;
          return input;
        };
        let hints: WakeHint[] = [];
        if (active.eventWake) {
          const fitsWorker = async () => {
            // Read capacity from this worker's pinned model, not the intake model or
            // a subsequently changed assistant selection. This makes no provider call.
            const budget = await this.owner({ ...state, sessionId: agent.sessionId }, () =>
              this.ctx.llm.budget({ maxOutputTokens: 2048 }),
            );
            // The auxiliary budget already reserves output/wrappers. Leave additional
            // room for the investigator's tools, system prompt and retained history.
            const limit = Math.floor(budget.maxInputTokens * 0.75);
            if (!Number.isSafeInteger(limit) || limit <= 0)
              throw Error('Investigation model input capacity is unavailable');
            const fits = (items: WakeHint[]) => {
              const input = inputFor(items);
              if (estimatePluginLlmInputTokens('', input) > limit) return false;
              try {
                decodeMessageContent({ text: input });
                return true;
              } catch {
                return false;
              }
            };
            if (!fits([])) throw Error('Investigation model cannot fit the wake instructions');
            return { fits, limit };
          };
          let capacity = await fitsWorker();
          let batch = await this.intake.prepare(active.eventWake, capacity.fits);
          if (
            state.pending &&
            (typeof active.wakeInputTokens === 'number'
              ? active.wakeInputTokens > capacity.limit
              : batch.oversized)
          ) {
            // Old unbounded captures may already have a rejected, uncompressible head
            // message. Keep that history intact and recover on a fresh worker once.
            const recovered = this.store.update((s) => {
              if (s.active?.id !== active.id) throw Error('Quick wake ownership changed');
              const mode = s.contextWake?.mode ?? this.parent.store.get()?.contextMode ?? 'legacy';
              s.contextWake = { id: randomUUID(), mode };
              if (mode === 'legacy') s.legacyWorkerKey = s.contextWake.id;
              s.active.messageId = randomUUID();
              // A fresh worker starts a fresh history: the recorded body belongs to the
              // old Session and must not be replayed into this one.
              delete s.active.submission;
              s.active.wakeInputTokens = 0;
            });
            active.messageId = recovered.active.messageId;
            agent = await this.worker(this.state());
            this.agent = agent;
            const snapshot = await agent.snapshot();
            if (snapshot?.agent?.status === 'running' || awaitingUser(snapshot))
              throw Error('Recovery worker is not idle');
            first = true;
            capacity = await fitsWorker();
            batch = await this.intake.prepare(active.eventWake, capacity.fits);
          }
          this.store.update((s) => {
            if (s.active?.id !== active.id) throw Error('Quick wake ownership changed');
            s.active.eventWake = { ids: batch.ids };
          });
          active.eventWake = { ids: batch.ids };
          hints = batch.hints;
          if (!hints.length && !active.periodic) {
            // Unreadable/oversized hints stay captured in the intake journal. They do
            // not own a failed activation or block another hint/the periodic cadence.
            this.store.update((s) => {
              if (s.active?.id !== active.id) throw Error('Quick wake ownership changed');
              s.active = null;
              s.pending = null;
              s.retryAt = null;
              s.lastError = null;
              this.store.log('quick-deferred', { id: active.id });
            });
            return 'deferred' as const;
          }
        }
        // The body is persisted with the activation. It deliberately carries the current
        // UTC time and each hint's age, so recomposing it on a retry can never match what
        // the Host already recorded under this identity. Redelivery therefore resends the
        // recorded text byte for byte; only a body that genuinely changed (prompt version,
        // captured hints or a fresh worker Session) earns a new identity.
        const capture = [...hints]
          .sort((a, b) => a.at - b.at)
          .map((hint) => `${hint.at}:${hint.direction}`);
        const recorded = active.submission;
        const sameCapture =
          recorded?.version === version &&
          recorded.sessionId === agent.sessionId &&
          recorded.capture.length === capture.length &&
          recorded.capture.every((hint: string, index: number) => hint === capture[index]);
        const composed = inputFor(hints);
        let input = sameCapture ? recorded.input : composed;
        let identity = active.messageId;
        // Observe the identity before submitting it: an admission that outlived a restart
        // must be awaited, never submitted again.
        const observed = await this.owner(state, () => agent.messageExecution(identity)).catch(
          () => {
            this.abort.signal.throwIfAborted();
            this.parent.abort.signal.throwIfAborted();
            // An unreadable query is not proof of admission; an identical resubmission is
            // deduplicated by the Host's durable receipt.
            return undefined;
          },
        );
        if (['failed', 'aborted', 'cancelled'].includes(observed?.state)) {
          // A terminal admission cannot be resumed and replaying it only fails again.
          identity = randomUUID();
          input = composed;
        } else if (recorded && input !== recorded.input) {
          // The body really changed, so it cannot be replayed under the old identity.
          identity = randomUUID();
        }
        this.store.update((s) => {
          if (s.active?.id !== active.id) throw Error('Quick wake ownership changed');
          s.active.messageId = identity;
          s.active.submission = {
            messageId: identity,
            version,
            sessionId: agent.sessionId,
            capture,
            input,
          };
          if (active.eventWake) s.active.wakeInputTokens = estimatePluginLlmInputTokens('', input);
        });
        active.messageId = identity;
        if (!['owned', 'pending', 'completed'].includes(observed?.state)) {
          modelFrom = Date.now();
          let result: any;
          try {
            result = await this.owner(state, () => agent.followup(input, { messageId: identity }));
          } catch (error) {
            this.abandonIdentity(active.id, error);
            throw error;
          }
          if (!['turn_started', 'followup'].includes(result?.disposition)) {
            this.abandonIdentity(active.id, result);
            throw Error('Host rejected quick discovery wake');
          }
        }
        // whenIdle alone does not prove a queued message entered execution.
        for (;;) {
          this.ready();
          const execution = await agent.messageExecution(active.messageId);
          if (['owned', 'completed'].includes(execution?.state)) break;
          if (['failed', 'aborted'].includes(execution?.state))
            throw Error(`Quick wake ${execution.state}`);
          await delay(50, undefined, { signal: this.abort.signal });
        }
        await agent.whenIdle(this.abort.signal);
        const snapshot = await agent.snapshot();
        if (
          awaitingUser(snapshot) ||
          ['failed', 'aborted', 'blocked', 'waiting_for_user'].includes(snapshot?.agent?.status)
        )
          throw Error(`Quick discovery ended with ${snapshot?.agent?.status}`);
        this.ready();
        this.store.update((s) => {
          s.active.executionCompleted = true;
          s.promptVersion = version;
        });
      }
      this.forward();
      outcome = this.state()?.active?.reports?.some((r: any) => r.messages.length)
        ? 'reported'
        : 'no_report';
      this.store.update((s) => {
        if (s.active?.id !== active.id) throw Error('Quick wake ownership changed');
        if (active.eventWake) this.intake.complete(active.eventWake);
        if (!active.eventWake) {
          s.checkedThrough = active.to;
          s.checkedTokens = active.tokens;
        }
        if (active.periodic || !active.eventWake) s.lastPeriodicFinishedAt = this.now();
        s.lastFinishedAt = this.now();
        s.lastError = null;
        s.retryAt = null;
        s.active = null;
        s.pending = null;
        delete s.contextWake;
        this.store.log('quick-completed', { id: active.id, checkedThrough: active.to });
      });
    } catch (error) {
      if (!this.abort.signal.aborted)
        this.store.update((s) => {
          // Keep captured bounds/outbox. New arrivals remain outside this watermark.
          s.pending = s.active;
          s.active = null;
          s.lastError = String(error);
          // Keep the recorded body and identity: an ambiguous failure may still have been
          // admitted, so the retry reconciles by observing that identity first instead of
          // starting a second investigation of the same wake.
          s.retryAt = this.now() + s.intervalMs;
          this.store.log('quick-failed', {
            id: active.id,
            error: String(error),
          });
        });
    } finally {
      this.agent = undefined;
      // A retry that only redelivers an earlier report ran no model: not a run.
      if (modelFrom !== undefined)
        await this.ctx.runCost?.record({
          kind: 'quick_discovery',
          runId: active.id,
          startedAt,
          endedAt: Date.now(),
          outcome,
          segments: [{ sessionId: agent.sessionId, from: modelFrom, to: Date.now() }],
        });
    }
  }
  async close() {
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    this.abort.abort(Error('Quick discovery stopped'));
    if (this.agent && this.owned) await this.agent.cancel();
    await Promise.allSettled([this.ticking, this.running, this.intake.close()].filter(Boolean));
    if (this.owned) this.store.release();
  }
}

export function initializeQuickDiscovery(ctx: any, parent: any, directory: string, tickMs: number) {
  const quick = new QuickDiscoveryController(ctx, parent, directory);
  ctx.onStart(() => {
    quick.start(tickMs);
    return () => quick.close();
  });
  ctx.onClose(() => quick.store.close());
  ctx.backgroundSessions.register(() => [quick.state()?.workerSession].filter(Boolean));
  const controlSchema = z
    .object({
      action: z.enum(['enable', 'pause', 'check', 'configure']),
      eventIntake: z
        .boolean()
        .optional()
        .describe(
          'Enable continuous source-change intake. Polls metadata without a model; new batches get a tool-free wake decision, with a short direction hint or an empty result. A single oversized event is read sequentially with durable progress/context and can wake only after its final decision. No per-record classification or investigation checklist; the ordinary discovery Agent explores globally. Independent from the periodic cadence. Starts at current source positions.',
        ),
      intakeModelKey: z
        .string()
        .regex(/^[^:]+::.+$/)
        .optional()
        .describe(
          'Configured connectionSlug::modelId for the short intake call; omitted uses the assistant model. Choose a small model to control cost.',
        ),
      intervalMinutes: z.number().int().min(1).max(1440).optional(),
      idleMinutes: z.number().int().min(1).max(10080).optional(),
      quietHours: quietHoursSchema
        .nullable()
        .optional()
        .describe(
          'Optional daily idle-only quiet window: start/end HH:mm and timeZone (e.g. Asia/Shanghai). Start inclusive, end exclusive; may cross midnight. New activity and explicit check still run. null disables the window; omission preserves it.',
        ),
    })
    .strict();
  ctx.api.register('assistant.quick-discovery', (input: unknown) =>
    quick.control(controlSchema.parse(input)),
  );
  ctx.api.register('assistant.quick-discovery-status', () => ({
    ...(quick.state() ?? { configured: false }),
    intake: quick.intake.status(),
    coordination: parent.coordinator.status(),
  }));
  for (const [name, description, parameters, impl] of [
    [
      'QuickDiscoveryControl',
      'Configure or enable the separate quick-help discovery schedule only on user request: activity checks default to 15 minutes, quiet fallback to 60. quietHours suppresses only idle wakes during a daily time window; new activity still wakes. check runs once even during quiet hours; pause stops future checks. Does not change broad discovery, index maintenance or specific tasks.',
      controlSchema,
      (input: any) => quick.control(input),
    ],
    [
      'QuickDiscoveryStatus',
      'Read quick-help discovery state, source observation limitations and last error without starting a model.',
      z.object({}),
      () => ({
        ...(quick.state() ?? { configured: false }),
        intake: quick.intake.status(),
        coordination: parent.coordinator.status(),
      }),
    ],
  ] as const)
    ctx.tools.register({
      name,
      description,
      parameters,
      executionSemantics: name.endsWith('Status') ? 'parallel' : 'exclusive_step',
      categoryHint: name.endsWith('Status') ? 'read' : 'file_write',
      impl: async (input: any, call: any) => {
        if (call.sessionId !== parent.store.get()?.sessionId)
          throw Error('Outside assistant conversation');
        return impl(input);
      },
    });
  ctx.tools.register({
    name: 'QuickDiscoveryReport',
    description:
      'Submit user-facing messages for delivery through the Bot. Write the actual message text, not an internal report or instructions to the Bot. Acceptance confirms handoff, not user delivery or task execution. Messages may be empty when no notification is useful; no event acknowledgement is required.',
    parameters: reportSchema,
    discovery: 'direct',
    categoryHint: 'file_write',
    executionSemantics: 'exclusive_step',
    impl: async (input: any, call: any) => quick.report(reportSchema.parse(input), call.sessionId),
  });
  ctx.tools.register({
    name: 'QuickDiscoveryNotebook',
    description:
      'Read bounded shared discovery memory, including current entries, historical versions, actual deliveries and linked feedback. Follow nextCursor using the same query. Prefer DiscoveryNotebook when preparing an incremental write; that tool also supplies the active execution identity.',
    parameters: memoryRead,
    categoryHint: 'read',
    executionSemantics: 'parallel',
    impl: async (input: any, call: any) => {
      if (call.sessionId !== quick.state()?.workerSession)
        throw Error('Not the quick discovery worker');
      parent.refreshNotebook();
      return parent.notebook.readMemory(memoryRead.parse(input));
    },
  });
  ctx.tools.filter?.((sessionId: string, tools: any[]) =>
    quick.store.worker(sessionId)?.role !== 'quick'
      ? tools
      : tools.filter(
          (tool) =>
            tool.name === 'QuickDiscoveryReport' ||
            tool.name === 'DiscoveryNotebookRemember' ||
            tool.name === 'tool_search' ||
            (tool.categoryHint === 'read' &&
              !/^(Matter|Initiative|QuickDiscoveryControl|MemoryIndex(Create|Write|Checkpoint|Maintain|Control|AddSources))/.test(
                tool.name,
              )) ||
            [
              'Read',
              'Glob',
              'Grep',
              'Recall',
              'WebSearch',
              'WebFetch',
              'DiscoveryContext',
            ].includes(tool.name),
        ),
  );
  ctx.systemPrompt.section({
    name: 'quick-discovery.role',
    order: 812,
    text: ({ sessionId }: any) =>
      quick.store.worker(sessionId)?.role === 'quick'
        ? '你在快速发现后台会话中运行，只读调查，不委派执行任务，不自行设置心跳。用 DiscoveryNotebook 读取相关记忆；仅通过 DiscoveryNotebookRemember 提交知识增量，不直接修改记事本文件。'
        : undefined,
  });
  return quick;
}
