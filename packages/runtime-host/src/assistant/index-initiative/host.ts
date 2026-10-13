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

import type { AssistantModuleServices } from '../service.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { InitiativeStore } from './store.js';
import { InitiativeController } from './controller.js';
import { ASSISTANT_ROLE } from './prompt.js';
import { registerAssistant } from './assistant.js';
export async function initializeInitiative(
  ctx: AssistantModuleServices,
  directory: string,
  config: any = {},
) {
  const limits = { tickMs: config.tickMs ?? 5000 };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 10 || value > 3600000)
      throw Error(`Invalid ${name}`);
  const location = { value: directory };
  const store = new InitiativeStore(location.value, randomUUID());
  const controller = new InitiativeController(ctx, store, limits);
  ctx.onClose(() => store.close());
  const activate = () => {
    controller.start();
    return () => controller.close();
  };
  ctx.onStart(activate);
  registerAssistant(ctx, store, controller);
  const visible = (call: any) => {
    const s = store.get();
    if (s && s.sessionId !== call.sessionId) throw Error('Initiative is outside this conversation');
    return s;
  };
  const register = (name: string, description: string, parameters: any, impl: any) =>
    ctx.tools.register({
      name,
      description,
      parameters,
      categoryHint: name === 'InitiativeStatus' ? 'read' : 'file_write',
      executionSemantics: name === 'InitiativeStatus' ? 'parallel' : 'exclusive_step',
      impl: async (input: any, call: any) =>
        JSON.parse(JSON.stringify(await impl(parameters.parse(input), call))),
    });
  register(
    'InitiativeEnable',
    'Enable host-scheduled heartbeats in THIS ordinary chat Session on explicit user request. User messages and heartbeats share normal history. No separate worker, notebook or exit checkpoint. Set cadence only as requested by the user.',
    z.object({
      intervalMinutes: z.number().int().min(1).max(10080).default(30),
    }),
    (input: any, call: any) => controller.enable(input, call),
  );
  register(
    'InitiativeStatus',
    'Read heartbeat scheduling metadata for this conversation.',
    z.object({}),
    (_: any, call: any) => visible(call) ?? { configured: false },
  );
  register(
    'InitiativeControl',
    'Pause, resume, or request one immediate heartbeat only on a direct user request. Pause stops future heartbeats without cancelling the chat.',
    z.object({ action: z.enum(['pause', 'resume', 'check']) }),
    (input: any, call: any) => controller.control(input.action, call),
  );
  ctx.systemPrompt.section({
    name: 'index-initiative.assistant',
    order: 810,
    text: ({ sessionId }: any) =>
      store.get()?.sessionId === sessionId ? ASSISTANT_ROLE : undefined,
  });
  ctx.systemPrompt.context({
    name: 'index-initiative.clock',
    order: 810,
    text: ({ sessionId }: any) =>
      store.get()?.sessionId === sessionId
        ? `Runtime clock: ${new Date().toISOString()}`
        : undefined,
  });
}
