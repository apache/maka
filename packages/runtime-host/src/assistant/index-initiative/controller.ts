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

import { ASSISTANT_BACKGROUND_SESSION_LABEL } from '@maka/core/session';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { InitiativeStore } from './store.js';
import { awaitingUser } from '../execution-outcome.js';
import { wake } from './prompt.js';

export class InitiativeController {
  abort = new AbortController();
  timer: any;
  heartbeat: any;
  owned = false;
  running?: Promise<void>;
  private activeAgent?: any;
  ticking?: Promise<void>;
  enabling = false;
  private bindingResolution?: Promise<void>;
  get bindingReady(): Promise<void> {
    // Share in-flight work and successful resolution, but let the next caller
    // retry a failed startup lookup without restarting the Host.
    return (this.bindingResolution ??= this.resolveBinding().catch((error) => {
      this.bindingResolution = undefined;
      throw error;
    }));
  }
  constructor(
    readonly ctx: any,
    readonly store: InitiativeStore,
    readonly config: any,
  ) {}
  start() {
    const acquire = () => {
      const owned = this.store.lease();
      if (owned && !this.owned) this.store.recover();
      if (!owned && this.owned) this.abort.abort(Error('Initiative ownership lost'));
      this.owned = owned;
    };
    acquire();
    // Observe startup failure; API callers can retry the lookup later.
    void this.bindingReady.catch(() => {});
    this.heartbeat = setInterval(acquire, 10000);
    this.heartbeat.unref?.();
    this.timer = setInterval(() => void this.tick(), this.config.tickMs);
    this.timer.unref?.();
    void this.tick();
  }
  private async resolveBinding() {
    if (this.store.get() || !this.owned) return;
    const matches = (await this.ctx.sessionQuery.list()).filter((s: any) =>
      s.labels?.includes('personal-assistant'),
    );
    if (matches.length > 1) throw Error('Multiple assistant conversations found');
    if (!matches.length) return; // First creation is resolved by assistant.bind.
    const session = matches[0];
    if (!session.cwd) throw Error('Assistant conversation has no Host cwd');
    this.ready();
    this.store.bind({ sessionId: session.id, cwd: session.cwd });
  }
  ready() {
    this.abort.signal.throwIfAborted();
    this.store.fence();
  }
  asOwner<T>(s: any, fn: () => T): T {
    return this.ctx.agents.withInvocation(
      {
        sessionId: s.sessionId,
        cwd: s.cwd,
        turnId: `initiative-${this.store.owner}`,
        toolCallId: randomUUID(),
        abortSignal: this.abort.signal,
      },
      fn,
    );
  }
  tick(): Promise<void> {
    if (this.ticking || this.running || !this.owned || this.abort.signal.aborted)
      return this.ticking ?? Promise.resolve();
    this.ticking = this.dispatch()
      .catch((error) => {
        try {
          this.store.update((s) => {
            if ((s?.enabled || s?.checkRequested) && !s.active) {
              s.lastError = String(error);
              s.nextAt = Date.now() + 30000;
            }
          });
        } catch {
          /* Lease lost. */
        }
      })
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }
  async dispatch() {
    const s = this.store.get();
    if ((!s?.enabled && !s?.checkRequested) || s.active || s.nextAt > Date.now()) return;
    const agent = await this.worker(s, s.candidateReport ? 'judgement' : 'discovery');
    const snapshot = await agent.snapshot();
    if (snapshot?.agent?.status === 'running' || awaitingUser(snapshot)) return;
    this.ready();
    const current = this.store.claim();
    if (!current?.active) return;
    this.running = this.run(agent, current).finally(() => {
      this.running = undefined;
    });
  }
  private async worker(s: any, phase: 'discovery' | 'judgement') {
    return this.asOwner(s, async () => {
      const field = phase === 'discovery' ? 'discoverySession' : 'judgementSession';
      let sessionId = s[field];
      if (!sessionId) {
        const label = `assistant-${phase}:${s.sessionId}`;
        const matches = (await this.ctx.sessionQuery.list()).filter((item: any) =>
          item.labels?.includes(label),
        );
        if (matches.length > 1) throw Error(`Multiple ${phase} workers found`);
        sessionId =
          matches[0]?.id ??
          (
            await this.ctx.agents.create({
              background: true,
              name: phase === 'discovery' ? '个人助手 · 主动发现' : '个人助手 · 发现判断',
              labels: [label, ASSISTANT_BACKGROUND_SESSION_LABEL],
            })
          ).sessionId;
        this.store.update((current) => {
          current[field] = sessionId;
        });
      }
      return this.ctx.agents.resume({ sessionId });
    });
  }
  private async execute(agent: any, state: any) {
    this.ready();
    this.activeAgent = agent;
    const admitted = await agent.followup(wake(state));
    if (!['turn_started', 'followup'].includes(admitted?.disposition))
      throw Error('Host rejected proactive wake');
    while (
      admitted.disposition === 'followup' &&
      !JSON.stringify(await agent.transcript()).includes(`Heartbeat ID: ${state.active.id}`)
    )
      await delay(25, undefined, { signal: this.abort.signal });
    await agent.whenIdle(this.abort.signal);
    const snapshot = await agent.snapshot();
    const status = snapshot?.agent?.status;
    if (['aborted', 'blocked', 'waiting_for_user'].includes(status) || awaitingUser(snapshot))
      throw Error(`Heartbeat ended with ${status}; inspect before resuming`);
    this.ready();
  }
  async run(agent: any, state: any) {
    const id = state.active.id;
    this.activeAgent = agent;
    try {
      await this.execute(agent, state);
      if (state.active.phase === 'discovery') {
        const next = this.store.update((s) => {
          if (s.active?.id !== id) throw Error('Heartbeat ownership changed');
          if (!s.candidateReport)
            throw Error('Discovery finished without a report; judgement was not started');
          s.active.phase = 'judgement';
        });
        const judge = await this.worker(next, 'judgement');
        const snapshot = await judge.snapshot();
        if (snapshot?.agent?.status === 'running' || awaitingUser(snapshot))
          throw Error('Judgement worker is busy or awaiting user input; report retained');
        await this.execute(judge, this.store.get());
      }
      this.store.finish(id);
    } catch (e) {
      try {
        this.store.fence();
        if (this.store.get()?.active?.id === id) {
          const message = String(e);
          this.store.finish(id, message);
        }
      } catch {
        /* A newer owner fences writes and cancellation. */
      }
    } finally {
      this.activeAgent = undefined;
    }
  }
  async enable(input: any, call: any) {
    await this.bindingReady;
    this.ready();
    if (this.enabling) throw Error('Initiative configuration is already in progress');
    this.enabling = true;
    try {
      const old = this.store.get();
      if (!old || old.sessionId !== call.sessionId)
        throw Error('Only the assistant conversation may configure heartbeats');
      if (old?.enabled && input.intervalMinutes === undefined) return old;
      const s = this.store.configure(
        { sessionId: old.sessionId, cwd: old.cwd },
        input.intervalMinutes === undefined
          ? (old?.intervalMs ?? 1800000)
          : input.intervalMinutes * 60000,
      );
      void this.tick();
      return s;
    } finally {
      this.enabling = false;
    }
  }
  async configure(input: { intervalMinutes: number }, call: any) {
    await this.bindingReady;
    this.ready();
    const old = this.store.get();
    if (!old || old.sessionId !== call.sessionId)
      throw Error('Only the assistant conversation may configure heartbeats');
    return this.store.configure(
      { sessionId: old.sessionId, cwd: old.cwd },
      input.intervalMinutes * 60000,
      old?.enabled ?? false,
    );
  }
  async control(action: string, call: any) {
    this.ready();
    const old = this.store.get();
    if (!old || old.sessionId !== call.sessionId)
      throw Error('Only the assistant conversation controls heartbeats');
    const s = this.store.control(action);
    if (action !== 'pause') void this.tick();
    return s;
  }
  async close() {
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    // Stopping the entire feature must stop the heartbeat execution, not only its observer.
    let failure: unknown;
    try {
      if (this.activeAgent && this.owned) {
        this.store.fence();
        await this.activeAgent.cancel();
      }
    } catch (error) {
      failure = error;
    }
    this.abort.abort(Error('Initiative service stopped'));
    await Promise.allSettled([this.ticking, this.running].filter(Boolean));
    if (this.owned) this.store.release();
    if (failure) throw failure;
  }
}
