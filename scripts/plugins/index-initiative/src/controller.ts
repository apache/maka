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
import { InitiativeStore } from './store.js';
import { wake } from './prompt.js';

export class InitiativeController {
  abort = new AbortController();
  timer: any; heartbeat: any; owned = false; running?: Promise<void>; ticking?: Promise<void>; enabling = false;
  constructor(readonly ctx: any, readonly store: InitiativeStore, readonly config: any) {}
  start() {
    const acquire = () => {
      const owned = this.store.lease();
      if (owned && !this.owned) this.store.recover();
      if (!owned && this.owned) this.abort.abort(Error('Initiative ownership lost'));
      this.owned = owned;
    };
    acquire(); this.heartbeat = setInterval(acquire, 10000); this.heartbeat.unref?.();
    this.timer = setInterval(() => void this.tick(), this.config.tickMs); this.timer.unref?.(); void this.tick();
  }
  ready() { this.abort.signal.throwIfAborted(); this.store.fence(); }
  asOwner<T>(s: any, fn: () => T): T {
    return this.ctx.agents.withInvocation({ sessionId: s.sessionId, cwd: s.cwd, turnId: `initiative:${this.store.owner}`, toolCallId: randomUUID(), abortSignal: this.abort.signal }, fn);
  }
  tick(): Promise<void> {
    if (this.ticking || this.running || !this.owned || this.abort.signal.aborted) return this.ticking ?? Promise.resolve();
    this.ticking = this.dispatch().catch(error => {
      try { this.store.update(s => { if (s?.enabled && !s.active) { s.lastError = String(error); s.nextAt = Date.now() + 30000; } }); } catch { /* Lease lost. */ }
    }).finally(() => { this.ticking = undefined; }); return this.ticking;
  }
  async dispatch() {
    const s = this.store.get(); if (!s?.enabled || s.active || s.nextAt > Date.now()) return;
    const agent = await this.asOwner(s, () => this.ctx.agents.resume({ sessionId: s.sessionId }));
    if (['running', 'waiting_for_user', 'blocked'].includes((await agent.snapshot())?.agent?.status)) return;
    this.ready(); const current = this.store.claim(); if (!current?.active) return;
    this.running = this.run(agent, current).finally(() => { this.running = undefined; });
  }
  async run(agent: any, state: any) {
    const id = state.active.id; let timer: any;
    try {
      const admitted = await agent.followup(wake(state, await agent.transcript()));
      if (!['turn_started', 'followup'].includes(admitted?.disposition)) throw Error('Host rejected proactive wake');
      const completion = async () => {
        // Queued admission is not completion; wait for its input to enter Session history.
        while (admitted.disposition === 'followup' && !JSON.stringify(await agent.transcript()).includes(`Heartbeat ID: ${id}`))
          await delay(25, undefined, { signal: this.abort.signal });
        await agent.whenIdle(this.abort.signal);
      };
      await Promise.race([completion(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Proactive check timed out; inspect effects before resuming')), this.config.runTimeoutMs); timer.unref?.(); })]);
      const status = (await agent.snapshot())?.agent?.status;
      if (['aborted', 'blocked', 'waiting_for_user'].includes(status)) throw Error(`Heartbeat ended with ${status}; inspect before resuming`);
      this.store.finish(id);
    } catch (e) {
      try {
        this.store.fence();
        if (this.store.get()?.active?.id === id) {
          this.store.finish(id, String(e));
          // Shared foreground Session: do not cancel a user's concurrent turn.
        }
      } catch { /* A newer owner fences writes and cancellation. */ }
    } finally { clearTimeout(timer); }
  }
  async enable(input: any, call: any) {
    this.ready();
    if (this.enabling) throw Error('Initiative configuration is already in progress');
    this.enabling = true;
    try {
    const old = this.store.get();
    if (old && old.sessionId !== call.sessionId) throw Error('Only the assistant conversation may configure heartbeats');
    const s = this.store.configure({ sessionId: call.sessionId, cwd: call.cwd }, input.instructions, input.intervalMinutes * 60000);
    void this.tick(); return s;
    } finally { this.enabling = false; }
  }
  async control(action: string, call: any) {
    this.ready(); const old = this.store.get();
    if (!old || old.sessionId !== call.sessionId) throw Error('Only the assistant conversation controls heartbeats');
    const s = this.store.control(action);
    if (action !== 'pause') void this.tick();
    return s;
  }
  async close() {
    clearInterval(this.timer); clearInterval(this.heartbeat); this.abort.abort(Error('Initiative plugin stopped'));
    await Promise.allSettled([this.ticking, this.running].filter(Boolean));
    if (this.owned) this.store.release();
  }
}
