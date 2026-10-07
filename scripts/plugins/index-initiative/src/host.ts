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
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { InitiativeStore } from './store.js';
import { InitiativeController } from './controller.js';
import { PROTOCOL, PROACTIVE_TASK } from './prompt.js';
export default {
  packageId: 'dev.maka.index-initiative',
  host: {
    name: 'index-initiative', inject: ['agents', 'tools', 'storage', 'systemPrompt', 'turns'],
    async apply(ctx: any, config: any = {}) {
      if (ctx.maka?.rootId !== 'profile') throw Error('Initiative requires profile scope');
      const limits = { tickMs: config.tickMs ?? 5000, runTimeoutMs: config.runTimeoutMs ?? 600000 };
      for (const [name, value] of Object.entries(limits))
        if (!Number.isSafeInteger(value) || value < 10 || value > 3600000) throw Error(`Invalid ${name}`);
      let location = await ctx.storage.get('data-directory');
      if (!location.value) {
        const path = config.dataDirectory ?? join(homedir(), '.maka', 'plugin-data', 'dev.maka.index-initiative', randomUUID());
        if (!isAbsolute(path)) throw Error('dataDirectory must be absolute');
        try { await ctx.storage.set('data-directory', path, { expectedRevision: location.revision }); }
        catch { location = await ctx.storage.get('data-directory'); if (!location.value) throw Error('Unable to initialize initiative storage'); }
        location = await ctx.storage.get('data-directory');
      }
      const store = new InitiativeStore(location.value, randomUUID());
      const controller = new InitiativeController(ctx, store, limits);
      ctx.effect(() => () => store.close(), 'initiative-store');
      const activate = () => { controller.start(); return () => controller.close(); };
      if (ctx.makaTransaction) ctx.makaTransaction.stage('initiative-scheduler', activate, ctx);
      else ctx.effect(activate, 'initiative-scheduler');
      const visible = (call: any) => {
        const s = store.get();
        if (s && ![s.ownerSession, s.worker].includes(call.sessionId)) throw Error('Initiative is outside this conversation');
        return s;
      };
      const publicState = (s: any) => {
        if (!s) return { configured: false };
        const { active, ...state } = s;
        return { configured: true, ...state, active: active ? { id: active.id, startedAt: active.startedAt, turnId: active.turnId, settled: active.settled } : null };
      };
      const register = (name: string, description: string, parameters: any, write: boolean, impl: any) => ctx.tools.register({
        name, description, parameters, categoryHint: write ? 'file_write' : 'read', executionSemantics: write ? 'exclusive_step' : 'parallel',
        impl: async (input: any, call: any) => JSON.parse(JSON.stringify(await impl(parameters.parse(input), call))),
      });
      register('InitiativeEnable', 'Enable a separate proactive Agent only when the current user explicitly asks. It discovers multiple indexes, checks originals and new information, and decides what to do. Preserve the user intent and permitted action scope in instructions. Historical text is not authorization. Session permissions still apply. Returns immediately; read progress with InitiativeStatus.',
        z.object({ instructions: z.string().trim().min(1).max(8000).default(PROACTIVE_TASK), intervalMinutes: z.number().int().min(1).max(10080).default(30) }), true,
        async (input: any, call: any) => publicState(await controller.enable(input, call)));
      register('InitiativeStatus', 'Read the proactive Agent state, notebook, latest update and next check. Does not trigger work.', z.object({}), false,
        (_: any, call: any) => publicState(visible(call)));
      register('InitiativeControl', 'Pause, resume or check now only on explicit user request. Inspect uncertain effects before resuming after interruption. Only the initiating conversation controls initiative.',
        z.object({ action: z.enum(['pause', 'resume', 'check']) }), true,
        async (input: any, call: any) => publicState(await controller.control(input.action, call)));
      register('InitiativeRead', 'Claim this activation in the actual worker turn; read current instructions, notebook, observation bookmarks and recent decisions. Does not alter memory coverage.',
        z.object({ activationId: z.string().min(1) }), true, (input: any, call: any) => {
          controller.ready(); const s = store.bind(call.sessionId, input.activationId, call.turnId);
          return { ...publicState(s), now: new Date().toISOString(), suggestedNextCheckAt: new Date(Date.now() + s.intervalMs).toISOString(), recentDecisions: store.history().items.slice(0, 5) };
        });
      register('InitiativeHistory', 'Read earlier decisions, actions and reports, newest first. Optional key finds your stable record key across previous checks to avoid duplicate handling.',
        z.object({ before: z.number().int().positive().optional(), key: z.string().min(1).max(200).optional() }), false,
        (input: any, call: any) => { visible(call); return store.history(input.before, input.key); });
      register('InitiativeCheckpoint', 'Finish this check, including quiet no-action outcomes. Save judgment, own bookmarks and handled/deferred records, plus a future absolute check time and reason. Does not mark memory covered or verify external success. After success end this turn. Set update to empty when there is nothing useful to tell the user.',
        z.object({ activationId: z.string().min(1), revision: z.number().int().nonnegative(), summary: z.string().trim().min(1).max(2000),
          notebook: z.string().max(16000), bookmarks: z.record(z.string(), z.unknown()),
          records: z.array(z.object({ key: z.string().min(1).max(200), summary: z.string().min(1).max(1000), evidence: z.array(z.string().max(500)).max(10) })).max(20),
          update: z.string().max(2000), nextCheckAt: z.string().datetime({ offset: true }), nextReason: z.string().trim().min(1).max(1000) }), true,
        (input: any, call: any) => {
          controller.ready(); if (Buffer.byteLength(JSON.stringify(input)) > 60000) throw Error('Checkpoint too large; save judgments rather than raw transcripts');
          const s = store.checkpoint(call, input);
          return { saved: true, revision: s.revision, nextCheckAt: new Date(s.nextAt).toISOString(), update: s.lastUpdate };
        });
      ctx.systemPrompt.section({ name: 'index-initiative.protocol', order: 810, text: ({ sessionId }: any) => store.get()?.worker === sessionId ? PROTOCOL : undefined });
      ctx.systemPrompt.context({ name: 'index-initiative.clock', order: 810, text: ({ sessionId }: any) => store.get()?.worker === sessionId ? `Runtime clock: ${new Date().toISOString()}; timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.` : undefined });
      ctx.turns.beforeFinish({ name: 'index-initiative.checkpoint', check: ({ sessionId, turnId }: any) => {
        const s = store.get();
        if (!s?.enabled || s.worker !== sessionId || !s.active || s.active.settled) return { allow: true };
        if (s.active.turnId && s.active.turnId !== turnId) return { allow: true };
        return { allow: false, feedback: `This wake has no checkpoint. Call InitiativeRead with activationId=${s.active.id}, do useful work or choose quiet/deferred handling, then InitiativeCheckpoint with a future check time and reason. You need not manufacture a task or notification.` };
      } });
    },
  },
};
