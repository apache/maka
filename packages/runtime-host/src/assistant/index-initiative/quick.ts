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
import { InitiativeStore } from './store.js';
import { QUICK_DISCOVERY_TASK, quickWakeInput } from './quick-prompt.js';
import { awaitingUser } from '../execution-outcome.js';
import { ASSISTANT_BACKGROUND_SESSION_LABEL } from '@maka/core/session';

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

/** A separate ordinary worker. Stores scheduling/delivery only, never another notebook. */
export class QuickDiscoveryController {
  readonly store: InitiativeStore;
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
  }
  start(tickMs: number) {
    const acquire = () => {
      const owned = this.store.lease();
      if (owned && !this.owned)
        this.store.update((s) => {
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
      s.intervalMs = interval;
      s.idleMs = idle;
      if (quietHours !== undefined) s.quietHours = quietHours;
      if (input.action === 'enable') s.enabled = true;
      if (input.action === 'pause') {
        s.enabled = false;
        s.checkRequested = false;
      }
      if (input.action === 'check') s.checkRequested = true;
    });
  }
  private owner<T>(s: any, fn: () => T): T {
    return this.parent.asOwner(s, fn);
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
        this.ctx.sources.list().map(async (source: any) => {
          try {
            const token = await this.ctx.sources.activityToken(source.id);
            if (token === null)
              unavailable[source.id] =
                'No lightweight observation; idle fallback applies outside configured quiet hours';
            else tokens[source.id] = hash([source.scope, token]);
          } catch (error) {
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
    const last = s.lastFinishedAt ?? s.startedAt;
    const quiet = inQuietHours(now, s.quietHours);
    if (
      !s.checkRequested &&
      !s.pending &&
      (now < last + s.intervalMs ||
        (now < (s.observation?.at ?? 0) + s.intervalMs && (quiet || now < last + s.idleMs)))
    )
      return;
    // Cheap observations only: no source enumeration, body reads, index writes or model calls.
    const observation = await this.activity(s);
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
    if (!s.checkRequested && !s.pending && !changed && quiet) return;
    if (!s.checkRequested && !s.pending && !changed && now < last + s.idleMs) return;
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
  report(input: z.infer<typeof reportSchema>, sessionId: string) {
    this.ready();
    let ids: string[] = [];
    this.store.update((s) => {
      if (!s?.active || s.workerSession !== sessionId)
        throw Error('Not the active quick discovery worker');
      const fingerprint = hash(input.messages);
      const previous = s.active.reports.find((x: any) => x.key === input.key);
      if (previous && previous.fingerprint !== fingerprint)
        throw Error('Submission key reused with different content');
      if (!previous)
        s.active.reports.push({ key: input.key, fingerprint, messages: input.messages });
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
    try {
      this.forward();
      if (!active.executionCompleted) {
        this.parent.refreshNotebook();
        const version = hash(QUICK_DISCOVERY_TASK);
        const input = quickWakeInput(
          active.from,
          active.to,
          this.state().promptVersion !== version,
        );
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
      this.store.update((s) => {
        if (s.active?.id !== active.id) throw Error('Quick wake ownership changed');
        s.checkedThrough = active.to;
        s.checkedTokens = active.tokens;
        s.lastFinishedAt = this.now();
        s.lastError = null;
        s.retryAt = null;
        s.active = null;
        s.pending = null;
        this.store.log('quick-completed', { id: active.id, checkedThrough: active.to });
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
          this.store.log('quick-failed', { id: active.id, error: String(error) });
        });
    } finally {
      this.agent = undefined;
    }
  }
  async close() {
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    this.abort.abort(Error('Quick discovery stopped'));
    if (this.agent && this.owned) await this.agent.cancel();
    await Promise.allSettled([this.ticking, this.running].filter(Boolean));
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
  ctx.api.register(
    'assistant.quick-discovery-status',
    () => quick.state() ?? { configured: false },
  );
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
      () => quick.state() ?? { configured: false },
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
      'Submit user-facing messages for delivery through the Bot. Write the actual message text, not an internal report or instructions to the Bot. Acceptance confirms handoff, not user delivery or task execution.',
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
        ? '你在快速发现后台会话中运行，只读调查，不委派执行任务，不修改记事本，不自行设置心跳。'
        : undefined,
  });
  return quick;
}
