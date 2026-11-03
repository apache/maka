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

import type { MakaTool } from '@maka/runtime/tool-runtime';

const TASKS = 'mcp__desktop_workhub__tasks';
const REMINDER =
  'Before answering or performing other work, record this turn’s topic with tasks associate. Use fresh candidates and conversation context to resolve omitted subjects. Use targetSessionId: null and a reason only for unrelated, overview, or genuinely ambiguous requests. A prior turn’s association does not label this turn. Do not explain this internal step to the user.';

/** Per-composer, per-turn prerequisite. Reconstructed backends safely re-associate. */
export function createWorkHubTopicGate() {
  const associated = new Set<string>();
  const pending = (turnId: string) => !associated.has(turnId);
  const check = (name: string, args: any, turnId: string) => {
    if (!pending(turnId)) return;
    if (name === 'WorkHubInspect' || name === 'WorkHubResult') return;
    if (name === TASKS && ['candidates', 'associate'].includes(args?.request?.operation)) return;
    throw new Error(`WorkHub topic association required. ${REMINDER}`);
  };
  const observe = (name: string, args: any, turnId: string, output: unknown) => {
    if (name !== TASKS || args?.request?.operation !== 'associate') return;
    if (!output || typeof output !== 'object' || ('isError' in output && output.isError)) return;
    const result = 'structuredContent' in output ? output.structuredContent : output;
    if (
      !result ||
      typeof result !== 'object' ||
      !('operation' in result) ||
      result.operation !== 'associate' ||
      !('targetSessionId' in result) ||
      result.targetSessionId !== args.request.targetSessionId
    )
      return;
    if (
      result.targetSessionId !== null &&
      (!('targetSessionKey' in result) || typeof result.targetSessionKey !== 'string')
    )
      return;
    associated.add(turnId);
    if (associated.size > 100) associated.delete(associated.values().next().value!);
  };
  return {
    prompt(turnId: string) {
      return pending(turnId)
        ? {
            requireToolCall: true as const,
            contexts: [{ name: 'workhub-topic-required', text: REMINDER }],
          }
        : {};
    },
    wrap(tool: MakaTool): MakaTool {
      return {
        ...tool,
        ...(tool.prepareExecution
          ? {
              prepareExecution: async (args, context) => {
                check(tool.name, args, context.turnId);
                const prepared = await tool.prepareExecution!(args, context);
                return {
                  ...prepared,
                  execute: async (executionContext) => {
                    check(tool.name, args, context.turnId);
                    const output = await prepared.execute(executionContext);
                    observe(tool.name, args, context.turnId, output);
                    return output;
                  },
                };
              },
            }
          : {}),
        impl: async (args, context) => {
          check(tool.name, args, context.turnId);
          const output = await tool.impl(args, context);
          observe(tool.name, args, context.turnId, output);
          return output;
        },
      };
    },
  };
}
