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

import { z } from 'zod';
import type { MatterStore } from './matter.js';
import type { MakaTool, MakaToolContext } from './host-types.js';

export interface MatterToolsDeps {
  store: MatterStore;
  changed(): void;
  authorize?(ctx: MakaToolContext): void;
}
export function buildMatterTools(deps: MatterToolsDeps): MakaTool[] {
  const own = (ctx: MakaToolContext) => {
    deps.authorize?.(ctx);
    const m = deps.store.forSession(ctx.sessionId);
    if (!m?.activation || m.activation.turnId !== ctx.turnId)
      throw new Error('This turn does not own a matter activation');
    return {
      id: m.id,
      activationId: m.activation.id,
      settled: m.activation.settled,
    };
  };
  const operation = (ctx: MakaToolContext) =>
    `matter:${ctx.sessionId}:${ctx.turnId}:${ctx.toolCallId}`;
  const wake = z.object({
    kind: z.literal('at'),
    at: z.number().describe('Future absolute Unix milliseconds'),
  });
  return [
    {
      name: 'MatterRead',
      description:
        'Refresh file paths, revision and current time. This writes observation state and may bind a queued activation; it is not read-only. Read request.md, state.md and inbox.json with MatterReadFile; their contents are not returned here. Call alone.',
      parameters: z.object({
        activationId: z
          .string()
          .optional()
          .describe(
            'Activation ID from the latest wake, needed to bind a queued wake to this turn',
          ),
      }),
      categoryHint: 'file_write',
      executionSemantics: 'exclusive_step',
      impl: (input, ctx) => {
        deps.authorize?.(ctx);
        const m = deps.store.forSession(ctx.sessionId);
        if (
          input.activationId &&
          m?.activation?.id === input.activationId &&
          m.activation.turnId.startsWith('pending:')
        )
          deps.store.bindTurn(m.id, input.activationId, ctx.turnId);
        const o = own(ctx);
        deps.store.observe(o.id, o.activationId);
        return deps.store.workspace(o.id, o.activationId);
      },
    },
    {
      name: 'MatterCheckpoint',
      description:
        'Save current working state after meaningful progress. Does not end this run or change the user objective.',
      parameters: z.object({
        expectedRevision: z.number().int().positive(),
        stateFile: z
          .string()
          .describe(
            'Absolute path to this activation’s draft.md, edited with MatterWriteFile before submitting',
          ),
      }),
      categoryHint: 'file_write',
      executionSemantics: 'exclusive_step',
      impl: (input: { expectedRevision: number; stateFile: string }, ctx) => {
        const o = own(ctx);
        const result = deps.store.checkpoint(
          o.id,
          o.activationId,
          input.expectedRevision,
          deps.store.readDraft(o.id, o.activationId, input.stateFile),
          operation(ctx),
        );
        deps.changed();
        return deps.store.workspace(result.id, o.activationId);
      },
    },
    {
      name: 'MatterSettle',
      description:
        'Commit state and finish this activation: wait with real wake conditions, continue bounded work, or complete the original objective. No business tools may execute after success.',
      parameters: z.object({
        expectedRevision: z.number().int().positive(),
        stateFile: z
          .string()
          .describe(
            'Absolute path to this activation’s draft.md, edited with MatterWriteFile before submitting',
          ),
        disposition: z.enum(['continue', 'wait', 'complete']),
        wakes: z.array(wake).max(10).optional(),
        reason: z.string().min(1).max(2000),
        summary: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            'What this activation actually did and found. The host appends this to history with a timestamp.',
          ),
        next: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            'Possible next actions, based on the current judgment; future activations must reassess them.',
          ),
        update: z
          .string()
          .max(2000)
          .optional()
          .describe(
            'The only proactive notification channel. Include meaningful progress or a needed user decision here; final chat text is not delivered as a progress notification. Omit for unchanged checks.',
          ),
      }),
      categoryHint: 'file_write',
      executionSemantics: 'exclusive_step',
      impl: async (input, ctx) => {
        const o = own(ctx);
        const { stateFile, ...commit } = input;
        const result = deps.store.settle(
          o.id,
          o.activationId,
          {
            ...commit,
            stateText: deps.store.readDraft(o.id, o.activationId, stateFile),
          },
          operation(ctx),
        );
        deps.changed();
        return deps.store.workspace(result.id, o.activationId);
      },
    },
    {
      name: 'MatterReadFile',
      description:
        'Read an actual file from this matter’s manifest, or a historical state/draft snapshot referenced by changes.jsonl. Draft history is not published state. This is scoped to the current matter; use ordinary tools for other files.',
      parameters: z.object({ path: z.string() }),
      categoryHint: 'read',
      impl: ({ path }, ctx) => {
        const o = own(ctx);
        return deps.store.readFile(o.id, o.activationId, path);
      },
    },
    {
      name: 'MatterWriteFile',
      description:
        'Write the entire draft.md file for this activation. This edits a working file only; publish it with MatterCheckpoint or MatterSettle. Other matter files are host-owned.',
      parameters: z.object({ path: z.string(), content: z.string() }),
      categoryHint: 'file_write',
      executionSemantics: 'exclusive_step',
      impl: ({ path, content }, ctx) => {
        const o = own(ctx);
        deps.store.writeDraft(o.id, o.activationId, path, content);
        return {
          path,
          bytes: new TextEncoder().encode(content).length,
          published: false,
        };
      },
    },
  ];
}
