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
import { setTimeout as delay } from 'node:timers/promises';
import type { Matter, MatterStore } from './matter.js';
import type { PluginContext, MakaToolContext } from './host-types.js';
import { buildMatterPrompt } from './prompt.js';

/** Owns only plugin work. It restores authority only for sessions explicitly enrolled in its DB. */
export class MatterController {
  readonly owner = randomUUID();
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private ready = false;
  private ticking?: Promise<void>;
  private runs = new Map<string, Promise<void>>();
  private stopping = new AbortController();
  lastError?: string;
  constructor(
    readonly ctx: PluginContext,
    readonly store: MatterStore,
    readonly options: { tickMs?: number; runTimeoutMs?: number } = {},
  ) {}

  start() {
    this.active = true;
    void this.tick();
    this.schedule();
  }
  private schedule() {
    if (!this.active) return;
    this.timer = setTimeout(() => {
      void this.tick();
      this.schedule();
    }, this.options.tickMs ?? 5000);
    this.timer.unref?.();
  }
  assertReady() {
    if (!this.active || !this.ready)
      throw new Error(
        'Follow-up plugin is starting or another instance owns its state. Retry shortly.',
      );
  }
  /** A trusted Host plugin reconstitutes an invocation for its persisted session only.
   * Never accept sessionId/cwd from a remote request to this adapter. */
  async agent(sessionId: string) {
    const cwd = this.store.binding(sessionId);
    if (!cwd || !this.store.forSession(sessionId))
      throw new Error('Session is not enrolled in follow-ups');
    return this.ctx.agents.withInvocation(
      {
        sessionId,
        cwd,
        turnId: `matter-host:${this.owner}`,
        toolCallId: `matter-host:${randomUUID()}`,
        abortSignal: this.stopping.signal,
      },
      () => this.ctx.agents.resume({ sessionId }),
    );
  }
  tick(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.dispatch()
      .catch((e) => {
        this.lastError = String(e);
      })
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }
  private async dispatch() {
    if (!this.store.lease(this.owner, Date.now() + 30_000)) {
      this.ready = false;
      return;
    }
    if (!this.ready) {
      this.store.recover();
      this.ready = true;
    }
    this.store.enqueueDue();
    for (const m of this.store.list()) {
      if (!this.active || this.runs.size >= 2) break;
      if (
        this.runs.has(m.id) ||
        m.activation ||
        ['paused', 'completed', 'cancelled'].includes(m.status)
      )
        continue;
      if (!this.store.get(m.id).events.length) continue;
      const agent = await this.agent(m.sessionId);
      const snapshot = await agent.snapshot();
      if (snapshot?.agent?.status === 'running') continue; // do not inject into active human conversation
      const current = this.store.get(m.id).matter;
      if (
        !this.active ||
        current.activation ||
        ['paused', 'completed', 'cancelled'].includes(current.status)
      )
        continue;
      const claimed = this.store.claim(m.id);
      if (!claimed) continue;
      const run = this.run(claimed.matter, agent).finally(() => this.runs.delete(m.id));
      this.runs.set(m.id, run);
    }
  }
  private async run(m: Matter, agent: any, alreadyStarted = false) {
    const activationId = m.activation!.id;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let queued = false;
    try {
      if (!alreadyStarted) {
        const result = await agent.followup(
          buildMatterPrompt(this.store.workspace(m.id, activationId)),
        );
        if (result.disposition === 'blocked') throw new Error('Host rejected this wake');
        if (result.disposition === 'turn_started') {
          const latest = this.store.get(m.id).matter;
          if (
            latest.activation?.id === activationId &&
            latest.activation.turnId.startsWith('pending:')
          )
            this.store.bindTurn(m.id, activationId, result.turnId);
        } else if (result.disposition === 'followup') queued = true;
        else throw new Error('Unexpected wake admission result');
      }
      // A queued wake binds via MatterRead(activationId). Never re-submit an uncertain wake.
      const watchdog = new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Activation timed out; inspect effects before resuming')),
          this.options.runTimeoutMs ?? 600_000,
        );
        timeout.unref?.();
      });
      const completion = async () => {
        if (queued) {
          while (this.store.get(m.id).matter.activation?.turnId.startsWith('pending:')) {
            await delay(25, undefined, { signal: this.stopping.signal });
          }
        }
        await agent.whenIdle(this.stopping.signal);
      };
      await Promise.race([completion(), watchdog]);
      if (this.store.get(m.id).matter.activation?.turnId.startsWith('pending:'))
        throw new Error(
          'Queued wake ended without claiming its activation; inspect conversation before resuming',
        );
      this.store.finish(m.id, activationId);
    } catch (e) {
      this.lastError = String(e);
      const live = this.store.get(m.id).matter;
      if (live.activation?.id === activationId) {
        // Commit the fault before stopping, so no later Matter write can proceed.
        this.store.finish(m.id, activationId, String(e));
        await agent.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  async enroll(input: { title: string; request: string }, call: MakaToolContext) {
    this.assertReady();
    if (this.store.forSession(call.sessionId))
      throw new Error(
        'This conversation already has a follow-up; use MatterMessage or MatterControl',
      );
    const m = this.store.create({ ...input, sessionId: call.sessionId, cwd: call.cwd });
    const claimed = this.store.claim(m.id)!.matter;
    this.store.bindTurn(m.id, claimed.activation!.id, call.turnId);
    const agent = await this.agent(call.sessionId);
    const run = this.run(this.store.get(m.id).matter, agent, true).finally(() =>
      this.runs.delete(m.id),
    );
    this.runs.set(m.id, run);
    return this.store.workspace(m.id, claimed.activation!.id);
  }
  async control(
    id: string,
    action: 'pause' | 'resume' | 'cancel' | 'check',
    caller?: MakaToolContext,
  ) {
    this.assertReady();
    const before = this.store.get(id).matter;
    const result = this.store.control(id, action);
    if ((action === 'pause' || action === 'cancel') && before.activation) {
      const stop = async () => {
        const agent = await this.agent(before.sessionId);
        await agent.cancel();
        await this.runs.get(id);
      };
      if (caller?.turnId === before.activation.turnId)
        setTimeout(
          () =>
            void stop().catch((e) => {
              this.lastError = String(e);
            }),
          0,
        );
      else await stop();
    } else void this.tick();
    return result;
  }
  async message(id: string, text: string, call: MakaToolContext) {
    this.assertReady();
    const m = this.store.get(id).matter;
    if (['completed', 'cancelled'].includes(m.status)) throw new Error('Matter has ended');
    if (call.sessionId !== m.sessionId) throw new Error('Wrong session');
    if (m.activation && m.activation.turnId !== call.turnId)
      throw new Error('Previous activation is still stopping; retry after it exits');
    this.store.ingest(id, { key: randomUUID(), source: 'user', text });
    // A direct human turn adopts the matter; there is no writable Client bridge.
    if (m.activation?.turnId !== call.turnId) {
      if (m.status === 'paused') this.store.control(id, 'resume');
      const claimed = this.store.claim(id)!.matter;
      this.store.bindTurn(id, claimed.activation!.id, call.turnId);
      const agent = await this.agent(m.sessionId);
      const run = this.run(this.store.get(id).matter, agent, true).finally(() =>
        this.runs.delete(id),
      );
      this.runs.set(id, run);
    }
    const active = this.store.get(id).matter.activation!;
    this.store.observe(id, active.id);
    return this.store.workspace(id, active.id);
  }
  snapshot() {
    return {
      ready: this.ready,
      error: this.lastError ?? null,
      matters: this.store.list().map((m) => ({
        ...m,
        handoff: this.store.handoff(m.id),
        updates: this.store.updates(m.id).slice(0, 20),
        runs: this.store.runs(m.id).slice(0, 20),
      })),
    };
  }
  async *watch(signal: AbortSignal) {
    let previous = '';
    while (!signal.aborted && this.active) {
      const next = JSON.stringify(this.snapshot());
      if (next !== previous) {
        previous = next;
        yield JSON.parse(next);
      }
      try {
        await delay(1000, undefined, { signal });
      } catch {
        return;
      }
    }
  }
  async close() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    await this.ticking;
    // Reject stale tool writes first; then retire this plugin's run observers.
    for (const id of this.runs.keys()) {
      const m = this.store.get(id).matter;
      if (m.activation && !m.activation.settled) this.store.control(id, 'pause');
      try {
        await (await this.agent(m.sessionId)).cancel();
      } catch {}
    }
    this.stopping.abort(new Error('Follow-up plugin stopped'));
    await Promise.allSettled(this.runs.values());
    this.store.releaseLease(this.owner);
    this.ready = false;
  }
}
