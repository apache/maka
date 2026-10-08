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
import { ASSISTANT_ROLE, PROACTIVE_TASK } from './prompt.js';
export default {
  packageId: 'dev.maka.index-initiative',
  host: {
    name: 'index-initiative', inject: ['agents', 'tools', 'storage', 'systemPrompt'],
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
        if (s && s.sessionId !== call.sessionId) throw Error('Initiative is outside this conversation');
        return s;
      };
      const register = (name: string, description: string, parameters: any, impl: any) => ctx.tools.register({
        name, description, parameters, categoryHint: name === 'InitiativeStatus' ? 'read' : 'file_write',
        executionSemantics: name === 'InitiativeStatus' ? 'parallel' : 'exclusive_step',
        impl: async (input: any, call: any) => JSON.parse(JSON.stringify(await impl(parameters.parse(input), call))),
      });
      register('InitiativeEnable', 'Enable host-scheduled heartbeats in THIS ordinary chat Session on explicit user request. User messages and heartbeats share normal history. No separate worker, notebook or exit checkpoint. Set cadence only as requested by the user.',
        z.object({ instructions: z.string().trim().min(1).max(8000).default(PROACTIVE_TASK), intervalMinutes: z.number().int().min(1).max(10080).default(30) }),
        (input: any, call: any) => controller.enable(input, call));
      register('InitiativeStatus', 'Read heartbeat scheduling metadata for this conversation.', z.object({}),
        (_: any, call: any) => visible(call) ?? { configured: false });
      register('InitiativeControl', 'Pause, resume, or request one immediate heartbeat only on a direct user request. Pause stops future heartbeats without cancelling the chat.',
        z.object({ action: z.enum(['pause', 'resume', 'check']) }),
        (input: any, call: any) => controller.control(input.action, call));
      ctx.systemPrompt.section({ name: 'index-initiative.assistant', order: 810,
        text: ({ sessionId }: any) => store.get()?.sessionId === sessionId ? ASSISTANT_ROLE : undefined });
      ctx.systemPrompt.context({ name: 'index-initiative.clock', order: 810,
        text: ({ sessionId }: any) => store.get()?.sessionId === sessionId ? `Runtime clock: ${new Date().toISOString()}` : undefined });
    },
  },
};
