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

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { executeCodeCell } from '@maka/runtime/code-mode';
import type { AssistantModuleServices } from '../service.js';
import type { MakaToolContext } from './host-types.js';

const json = z.record(z.string(), z.json());
export const conditionInput = z.object({
  code: z
    .string()
    .min(1)
    .max(24000)
    .optional()
    .describe(
      'Async JavaScript body. Read input and checkpoint; call only tools.SourceList({}), SourceQuery({source,query}), SourceRead({source,object}), SessionRead({source,id,query}). Return {status:"pending"|"triggered",reason,evidence?:string[],checkpoint?:JSON object}. No Node, shell or unrestricted network. Verify the result against real evidence before waiting.',
    ),
  preset: z
    .enum(['source-appeared', 'session-revision'])
    .optional()
    .describe(
      'Use instead of code. source-appeared: input {source,query}, triggers when the narrowed query returns any object. session-revision: input {source?,id,revision}, triggers when the session history revision changes. Inspect the test result to verify scope.',
    ),
  input: json.default({}),
});
export interface ConditionDefinition {
  code: string;
  input: z.infer<typeof json>;
}
const presets = {
  'source-appeared': `const page = await tools.SourceQuery({source:input.source,query:input.query});
return {status:page.items.length ? "triggered" : "pending",reason:page.items.length ? "Source query found matching objects" : "No matching objects",evidence:page.items.slice(0,7).map(item => item.id)};`,
  'session-revision': `const snapshot = await tools.SessionRead({source:input.source ?? "maka",id:input.id,query:{limit:1}});
if (!snapshot || typeof snapshot.session.historyRevision !== "string" || typeof input.revision !== "string") throw Error("Session and baseline must expose a history revision");
return {status:snapshot.session.historyRevision !== input.revision ? "triggered" : "pending",reason:"Session history revision compared with the supplied baseline",evidence:[input.id]};`,
} as const;
export function normalizeCondition(value: unknown): ConditionDefinition {
  const input = conditionInput.parse(value);
  if (Boolean(input.code) === Boolean(input.preset))
    throw new Error('Supply either code or preset');
  return { code: input.code ?? presets[input.preset!], input: input.input };
}
export const conditionResult = z
  .object({
    status: z.enum(['pending', 'triggered']),
    reason: z.string().min(1).max(1000),
    evidence: z.array(z.string().min(1).max(512)).max(7).default([]),
    checkpoint: json.optional(),
  })
  .strict();
export type ConditionResult = z.infer<typeof conditionResult>;
export interface TestedCondition {
  id: string;
  matterId: string;
  definition: ConditionDefinition;
  testedAt: number;
  result: ConditionResult;
}
export function conditionId(matterId: string, definition: ConditionDefinition): string {
  return createHash('sha256')
    .update(JSON.stringify([matterId, definition]))
    .digest('hex');
}
export function parseConditionResult(value: unknown): ConditionResult {
  const result = conditionResult.parse(value);
  // Fits the observation engine's durable cursor, including UTF-8 and JSON escaping.
  if (Buffer.byteLength(JSON.stringify(result.checkpoint ?? {})) > 1800)
    throw new Error('Checker checkpoint exceeds 1800 bytes; keep only a bounded cursor.');
  if ([result.reason, ...result.evidence].some((value) => Buffer.byteLength(value) > 1024))
    throw new Error('Checker evidence or reason exceeds 1024 bytes');
  if (
    [result.reason, ...result.evidence].some((value) =>
      /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value),
    )
  )
    throw new Error('Checker reason and evidence must be single-line valid Unicode text');
  if (Buffer.byteLength(JSON.stringify([result.reason, ...result.evidence])) > 5000)
    throw new Error('Checker evidence exceeds the wake event budget');
  return result;
}
export type ConditionReader = (
  name: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<unknown>;
const names = ['SourceList', 'SourceQuery', 'SourceRead', 'SessionRead'] as const;
export async function runCondition(
  definition: ConditionDefinition,
  checkpoint: unknown,
  read: ConditionReader,
  signal: AbortSignal,
): Promise<ConditionResult> {
  const result = await executeCodeCell({
    code: `const input = ${JSON.stringify(definition.input)}; const checkpoint = ${JSON.stringify(checkpoint ?? null)};\n${definition.code}`,
    tools: names.map((name) => ({ name })),
    callTool: async (name, args, signal) => {
      if (!names.includes(name as (typeof names)[number]))
        throw new Error('Read-only checker capability unavailable');
      return read(name, args, signal);
    },
    isFatalToolError: () => true,
    signal,
  });
  if (!result.ok) throw new Error(`Checker ${result.error.kind}: ${result.error.message}`);
  return parseConditionResult(result.value);
}
/** The same scoped read bridge is used for the Agent's test and background observations. */
export function conditionReader(
  ctx: AssistantModuleServices,
  invocation: Pick<MakaToolContext, 'sessionId' | 'cwd' | 'turnId' | 'toolCallId'>,
): ConditionReader {
  return (name, value, signal) =>
    ctx.agents.withInvocation(
      {
        ...invocation,
        abortSignal: signal,
        emitOutput: () => {},
      },
      async () => {
        signal.throwIfAborted();
        const args = z.record(z.string(), z.unknown()).parse(value ?? {});
        switch (name) {
          case 'SourceList':
            return ctx.sources.list();
          case 'SourceQuery': {
            const source = z.string().parse(args.source);
            const page = await ctx.sources.query(
              source,
              z.record(z.string(), z.unknown()).parse(args.query ?? {}),
            );
            const allowed = new Set(await ctx.sources.authorize(source, page.items));
            if (page.items.some((item) => !allowed.has(item.id)))
              throw new Error('Source read permission denied');
            return page;
          }
          case 'SourceRead': {
            const object = z
              .object({
                id: z.string(),
                revision: z.string(),
                kind: z.string(),
                locator: z.record(z.string(), z.unknown()),
              })
              .passthrough()
              .parse(args.object);
            const result = await ctx.sources.read(z.string().parse(args.source), object);
            if (result.status === 'unavailable' || result.status === 'version_unavailable')
              throw new Error(`Source ${result.status}`);
            return result;
          }
          case 'SessionRead':
            return ctx.sessionQuery.sourceQuery(
              z.string().parse(args.source ?? 'maka'),
              z.string().parse(args.id),
              z.record(z.string(), z.unknown()).parse(args.query ?? {}),
            );
          default:
            throw new Error('Unsupported checker read');
        }
      },
    );
}
