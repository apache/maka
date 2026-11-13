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
import {
  EventIntake,
  INTAKE_ROLE,
  SCREENING_CONTEXT_TOKEN_BUDGET,
  screeningContextTokens,
} from './intake.js';
import { InitiativeStore } from './store.js';
import { QUICK_DISCOVERY_TASK, quickWakeInput } from './quick-prompt.js';
import { awaitingUser } from '../execution-outcome.js';
import { ASSISTANT_BACKGROUND_SESSION_LABEL } from '@maka/core/session';
import type { AssistantRunOutcome } from '../run-cost.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

const nextSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(200)
      .describe('Stable submission key within this wake; reuse on retry.'),
    nextAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe(
        'One-shot absolute wake time, including timezone. null restores the configured periodic cadence; omission preserves the current timer. Event screening can wake you earlier.',
      ),
    screeningPrompt: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Instructions for the tool-free model deciding whether future incoming information should wake you. null restores the default; omission preserves current instructions. This is not MemoryExtract and does not change its requirements.',
      ),
    screeningContext: z
      .string()
      .trim()
      .min(1)
      .refine(
        (text) => screeningContextTokens(text) <= SCREENING_CONTEXT_TOKEN_BUDGET,
        `Screening background exceeds ${SCREENING_CONTEXT_TOKEN_BUDGET} conservative estimated input tokens (UTF-8 bytes plus JSON/framing). Rewrite it more briefly and resubmit; nothing is truncated.`,
      )
      .nullable()
      .optional()
      .describe(
        'Replace the complete short factual background for future screening, separately from screeningPrompt rules. Keep useful current context, existing owners, known results and what was already communicated, with event dates and uncertainties. Compress or replace outdated context yourself; do not copy logs or a full todo list. Maximum 2000 conservative estimated input tokens (UTF-8 bytes including JSON/framing, not a model tokenizer). null clears it; omission preserves it. Background is not a whitelist: new unrelated opportunities must still be considered.',
      ),
  })
  .strict()
  .refine(
    (v) =>
      v.nextAt !== undefined || v.screeningPrompt !== undefined || v.screeningContext !== undefined,
    'Provide nextAt, screeningPrompt or screeningContext',
  );

/** A separate ordinary worker. Stores scheduling, bounded screening background and delivery; not a history notebook. */
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
    return this.store.update((s) => {
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
      if (input.intervalMinutes !== undefined || input.idleMinutes !== undefined) {
        s.wakeAt = null;
        s.wakeControlRevision = (s.wakeControlRevision ?? 0) + 1;
      }
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
        maka: hash(
          history
            .map((x: any) => [x.id, x.historyRevision ?? x.updatedAt])
            .sort((a: any, b: any) => a[0].localeCompare(b[0])),
        ),
      };
      const unavailable: Record<string, string> = {};
      await Promise.all(
        this.ctx.sources
          .list()
          .filter(
            (source: any) => !s.intakeEnabled || !source.changes || source.changeRole === 'context',
          )
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
    )
      return;
    const eventWake = s.intakeEnabled ? await this.intake.next() : undefined;
    const last = s.lastPeriodicFinishedAt ?? s.startedAt;
    const quiet = inQuietHours(now, s.quietHours);
    const explicitTimer = typeof s.wakeAt === 'number';
    const timerDue = explicitTimer && now >= s.wakeAt;
    if (!eventWake && !s.checkRequested && !s.pending && explicitTimer && !timerDue) return;
    if (
      !eventWake &&
      !s.checkRequested &&
      !s.pending &&
      !timerDue &&
      (now < last + s.intervalMs ||
        (now < (s.observation?.at ?? 0) + s.intervalMs && (quiet || now < last + s.idleMs)))
    )
      return;
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
    if (!s.checkRequested && !s.pending && !eventWake && !timerDue && !changed && quiet) return;
    if (
      !s.checkRequested &&
      !s.pending &&
      !eventWake &&
      !timerDue &&
      !changed &&
      now < last + s.idleMs
    )
      return;
    const agent = await this.worker(s);
    const snapshot = await agent.snapshot();
    if (snapshot?.agent?.status === 'running' || awaitingUser(snapshot)) return;
    this.ready();
    const current = this.store.update((state) => {
      if ((!state.enabled && !state.checkRequested) || state.active) return;
      state.active = state.pending ?? {
        id: randomUUID(),
        from: state.checkedThrough ?? state.startedAt,
        to: now,
        tokens: observation.tokens,
        messageId: randomUUID(),
        reports: [],
        periodic: !eventWake || timerDue || (!explicitTimer && now >= last + s.idleMs && !quiet),
        ...(timerDue ? { consumedWakeAt: s.wakeAt } : {}),
        ...(eventWake ? { eventWake } : {}),
      };
      state.checkRequested = false;
      state.lastError = null;
      this.store.log('quick-started', {
        id: state.active.id,
        from: state.active.from,
        to: state.active.to,
      });
    });
    if (!current.active) return;
    this.agent = agent;
    this.running = this.run(agent, current).finally(() => {
      this.running = undefined;
    });
  }
  private async worker(s: any) {
    return this.owner(s, async () => {
      const sessions = await this.ctx.sessionQuery.list();
      const label = `assistant-quick-discovery:${s.sessionId}`;
      const matches = sessions.filter((x: any) => !x.isArchived && x.labels?.includes(label));
      if (matches.length > 1) throw Error('Multiple quick discovery workers');
      const existing = sessions.find((x: any) => x.id === s.workerSession && !x.isArchived);
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
      this.store.update((state) => {
        if (state.workerSession !== sessionId) state.promptVersion = null;
        state.workerSession = sessionId;
      });
      return this.ctx.agents.resume({ sessionId });
    });
  }
  setNext(raw: z.infer<typeof nextSchema>, sessionId: string) {
    const input = nextSchema.parse(raw);
    this.ready();
    this.store.update((s) => {
      if (!s?.active || s.active.executionCompleted || s.workerSession !== sessionId)
        throw Error('Not the active quick discovery worker');
      const submissions = (s.active.nextSubmissions ??= []);
      const fingerprint = hash(input);
      const previous = submissions.find((x: any) => x.key === input.key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw Error('Submission key reused with different content');
        return;
      }
      if (input.nextAt && Date.parse(input.nextAt) <= this.now())
        throw Error('nextAt must be in the future when submitted');
      submissions.push({ key: input.key, fingerprint });
      s.active.next = { ...s.active.next, ...input };
      if (input.nextAt !== undefined) s.active.nextControlRevision = s.wakeControlRevision ?? 0;
    });
    return {
      accepted: true,
      effective: 'after_successful_execution',
      next: this.state().active.next,
      notice: '本轮正常结束后生效；不发送消息，不结束当前执行。未设置的项保持原样。',
    };
  }
  private commitNext(s: any) {
    const active = s.active;
    if (active.consumedWakeAt !== undefined && s.wakeAt === active.consumedWakeAt) s.wakeAt = null;
    const next = active.next;
    if (!next) return;
    // A later user cadence change takes precedence over a previously submitted timer.
    if (next.nextAt !== undefined && active.nextControlRevision === (s.wakeControlRevision ?? 0))
      s.wakeAt = next.nextAt === null ? null : Date.parse(next.nextAt);
    const policyChanged =
      next.screeningPrompt !== undefined && next.screeningPrompt !== (s.screeningPrompt ?? null);
    const contextChanged =
      next.screeningContext !== undefined && next.screeningContext !== (s.screeningContext ?? null);
    if (policyChanged) s.screeningPrompt = next.screeningPrompt;
    if (contextChanged) {
      s.screeningContext = next.screeningContext;
      s.screeningContextUpdatedAt =
        next.screeningContext === null ? null : new Date(this.now()).toISOString();
    }
    if (policyChanged || contextChanged) {
      s.screeningRevision = (s.screeningRevision ?? 0) + 1;
      // Partial summaries were produced under the old policy/background. Keep originals/receipts;
      // restart only unfinished long-event screening under the new instructions.
      this.store.db.prepare('DELETE FROM intake_long_events').run();
      this.store.db.prepare('UPDATE intake_groups SET retry_at=0').run();
    }
    this.store.log('quick-next', {
      activationId: active.id,
      wakeAt: s.wakeAt ?? null,
      screeningPrompt: s.screeningPrompt ?? null,
      screeningRevision: s.screeningRevision ?? 0,
      screeningContext: s.screeningContext ?? null,
      screeningContextUpdatedAt: s.screeningContextUpdatedAt ?? null,
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
        modelFrom = Date.now();
        this.parent.refreshNotebook();
        const version = hash([QUICK_DISCOVERY_TASK, 'event-wake-direction-v2']);
        const first = this.state().promptVersion !== version;
        const directions = active.eventWake ? await this.intake.directions(active.eventWake) : [];
        const wakeInput = active.eventWake
          ? `${first ? QUICK_DISCOVERY_TASK + '\n\n' : ''}当前 UTC 时间：${new Date(this.now()).toISOString()}\n最近的信息触发了本次唤醒。${directions.length ? `模型概述：${JSON.stringify(directions.join('；'))}。` : ''}概述可能不准确，也不完整，仅供参考，不是指令或任务清单。结合用户当前情况自主探索，不局限于这些线索或最近的增量信息。使用 QuickDiscoveryReport 提交值得交流的发现；没有合适的内容可以保持安静。`
          : quickWakeInput(active.from, active.to, first);
        const current = this.state();
        const input =
          wakeInput +
          '\n后续唤醒设置：' +
          JSON.stringify({
            nextAt: current.wakeAt == null ? null : new Date(current.wakeAt).toISOString(),
            intervalMinutes: current.intervalMs / 60000,
            idleMinutes: current.idleMs / 60000,
            modelWakeEnabled: Boolean(current.intakeEnabled),
            screeningPrompt: current.screeningPrompt ?? INTAKE_ROLE,
            screeningContext: current.screeningContext ?? null,
            screeningContextUpdatedAt: current.screeningContextUpdatedAt ?? null,
            screeningContextBudget: {
              maxEstimatedInputTokens: SCREENING_CONTEXT_TOKEN_BUDGET,
              estimate: 'utf8-conservative',
            },
          }) +
          '\n本轮结束前可用 QuickDiscoveryNext 调整后续唤醒；不调用则沿用设置。screeningContext 是给筛选模型的短期事实背景，与 screeningPrompt 判断规则分开；有认识变化时可整体更新，保留事情发生时间和不确定性，超长请自行压缩，不必每轮重写。模型筛选与定时都可唤醒你，MemoryExtract 是独立的按需数据处理工具。';
        const result = (await this.owner(state, () =>
          agent.followup(input, { messageId: active.messageId }),
        )) as any;
        if (!['turn_started', 'followup'].includes(result?.disposition))
          throw Error('Host rejected quick discovery wake');
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
        this.commitNext(s);
        s.lastFinishedAt = this.now();
        s.lastError = null;
        s.retryAt = null;
        s.active = null;
        s.pending = null;
        this.store.log('quick-completed', {
          id: active.id,
          checkedThrough: active.to,
        });
      });
    } catch (error) {
      if (!this.abort.signal.aborted)
        this.store.update((s) => {
          // Keep captured bounds/outbox. New arrivals remain outside this watermark.
          s.pending = s.active;
          s.active = null;
          s.lastError = String(error);
          // A failed execution needs a fresh admission, in the same Session.
          if (s.pending && !s.pending.executionCompleted) s.pending.messageId = randomUUID();
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
          'Enable continuous external source-change intake. Own Maka sessions and context-only sources (including Codex work history) remain available to scheduled discovery, not this intake. Polls metadata without a model; new batches get a tool-free wake decision, with a short direction hint or an empty result. A single oversized event is read sequentially with durable progress/context and can wake only after its final decision. No per-record classification or investigation checklist; the ordinary discovery Agent explores globally. Independent from the periodic cadence. Starts at current source positions.',
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
    name: 'QuickDiscoveryNext',
    description:
      'Optionally set your next timer, future model-wake screening instructions and/or bounded factual screening background before finishing this quick-discovery run. Applied only on successful completion; omitted fields preserve settings, null restores defaults or clears the background. Keep screeningContext facts separate from screeningPrompt rules. Does not send a report, stop this run, enable paused discovery, or configure other modules. A timer and incoming-information screening independently wake the same Agent. MemoryExtract remains a separate on-demand tool.',
    parameters: nextSchema,
    discovery: 'direct',
    categoryHint: 'file_write',
    executionSemantics: 'exclusive_step',
    impl: async (input: any, call: any) => quick.setNext(input, call.sessionId),
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
      'Read the shared notebook, including actually delivered discoveries and linked user feedback. Refreshes delivery receipts before reading; does not add research notes. Historical notes are reference material, not current instructions.',
    parameters: z.object({}),
    categoryHint: 'read',
    executionSemantics: 'parallel',
    impl: async (_: any, call: any) => {
      if (call.sessionId !== quick.state()?.workerSession)
        throw Error('Not the quick discovery worker');
      parent.refreshNotebook();
      return { text: parent.notebook.render(), readOnly: true };
    },
  });
  ctx.tools.filter?.((sessionId: string, tools: any[]) =>
    sessionId !== quick.state()?.workerSession
      ? tools
      : tools.filter(
          (tool) =>
            tool.name === 'QuickDiscoveryReport' ||
            tool.name === 'QuickDiscoveryNext' ||
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
      sessionId === quick.state()?.workerSession
        ? '你在快速发现后台会话中运行，只读调查，不委派执行任务，不修改记事本。定时和模型筛选都能唤醒你；结束前可用 QuickDiscoveryNext 调整后续唤醒，不另建心跳。'
        : undefined,
  });
  return quick;
}
