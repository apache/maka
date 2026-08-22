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
import {
  AGENT_GRAPH_SCHEDULE_MAX_ADD_WORK,
  AGENT_GRAPH_SCHEDULE_MAX_INPUT_IDS,
  AGENT_GRAPH_SCHEDULE_MAX_INSTRUCTION_CHARS,
  AGENT_GRAPH_SCHEDULE_MAX_REASON_CHARS,
  AGENT_GRAPH_SCHEDULE_MAX_RESULT_IDS,
  AGENT_GRAPH_SCHEDULE_MAX_SELECTED_RESULT_INPUTS,
  AGENT_GRAPH_SCHEDULE_MAX_STOP,
  AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION,
  decodeAgentGraphScheduleUpdate,
  type AgentGraphScheduleFinish,
  type AgentGraphScheduleStore,
  type AgentGraphScheduleUpdate,
  type AgentGraphScheduleUpdateRequest,
  type AgentGraphSelectedResultInput,
  type AgentGraphScheduledWork,
  type AgentGraphStoppedTarget,
  type AgentGraphWorkTarget,
} from '@maka/core/agent-graph-schedule';
import { stableHash } from './request-shape.js';
import type { AgentGraphSupervisorObservation } from './stream-graph-dispatch.js';
import type {
  AgentGraphActivationStatus,
  AgentGraphRecordFacet,
  AgentGraphSupervisorSignal,
} from './stream-graph-projection.js';
import type { AgentGraphReadinessWait } from './stream-graph-readiness.js';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';

export const VIEW_AGENT_GRAPH_TOOL_NAME = 'view_agent_graph';
export const UPDATE_AGENT_GRAPH_TOOL_NAME = 'update_agent_graph';
export const YIELD_AGENT_GRAPH_TOOL_NAME = 'yield_agent_graph';
export const AGENT_GRAPH_SUPERVISOR_TOOL_NAMES = [
  VIEW_AGENT_GRAPH_TOOL_NAME,
  UPDATE_AGENT_GRAPH_TOOL_NAME,
  YIELD_AGENT_GRAPH_TOOL_NAME,
] as const;

const TOOL_VIEW_MAX_TERMINAL_WORK = 64;
const TOOL_VIEW_MAX_STOPPED_TARGETS = 64;
const TOOL_VIEW_MAX_INSTRUCTION_CHARS = 2_000;
const TOOL_VIEW_MAX_ACTIVITY = 64;
const TOOL_VIEW_MAX_TERMINAL_OPERATORS = 64;
const TOOL_VIEW_MAX_LIVE_STATE = 64;
const TOOL_VIEW_MAX_HISTORICAL_RESULTS = 64;

const identitySchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Identity contains control characters');

const cursorSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Cursor contains control characters');

const addWorkSchema = z.preprocess(
  cleanAddWorkInput,
  z
    .object({
      target_kind: z
        .enum(['new_agent', 'new_preset', 'existing_operator'])
        .optional()
        .describe(
          'Explicit target discriminator. Use new_preset with subagent_id from agent_list, new_agent with a legacy agent_id, or existing_operator with operator_id. Unrelated optional identity fields are ignored.',
        ),
      agent_id: identitySchema
        .optional()
        .describe(
          'Legacy built-in agent id for new graph work. Use the exact agent_id from agent_list, not its profile. Prefer subagent_id when available.',
        ),
      subagent_id: identitySchema
        .optional()
        .describe('User-approved subagent preset id from agent_list for new graph work.'),
      operator_id: identitySchema
        .optional()
        .describe(
          'Runtime id of an EXISTING graph operator returned by view_agent_graph. Use only for follow-up work; set operator_id OR agent_id, never both.',
        ),
      instruction: z.string().trim().min(1).max(AGENT_GRAPH_SCHEDULE_MAX_INSTRUCTION_CHARS),
      input_ids: z
        .array(identitySchema)
        .max(AGENT_GRAPH_SCHEDULE_MAX_INPUT_IDS)
        .default([])
        .describe('Durable record or result ids that form this work item input frontier.'),
      selected_result_inputs: z
        .array(
          z
            .object({
              source_graph_id: identitySchema.describe('Completed earlier graph epoch id.'),
              result_id: identitySchema.describe(
                'Record id selected by the earlier graph finish operation.',
              ),
            })
            .strict(),
        )
        .max(AGENT_GRAPH_SCHEDULE_MAX_INPUT_IDS)
        .optional()
        .describe('Explicit results selected from completed earlier graph epochs.'),
      replaces: identitySchema
        .optional()
        .describe('Existing work or activation superseded by this request.'),
      replacement_mode: z
        .enum(['none', 'replace'])
        .optional()
        .describe(
          'Use none for normal work. Use replace only with a real replaces id. When none, any provider-filled replaces placeholder is ignored.',
        ),
    })
    .strip()
    .superRefine((value, ctx) => {
      const validTarget = value.target_kind
        ? value.target_kind === 'new_agent'
          ? Boolean(value.agent_id)
          : value.target_kind === 'new_preset'
            ? Boolean(value.subagent_id)
            : Boolean(value.operator_id)
        : (value.agent_id ? 1 : 0) + (value.subagent_id ? 1 : 0) + (value.operator_id ? 1 : 0) ===
          1;
      if (!validTarget) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Set target_kind=new_preset with subagent_id, target_kind=new_agent with agent_id, target_kind=existing_operator with operator_id, or omit target_kind and provide exactly one identity',
        });
      }
      if (value.replacement_mode === 'replace' && !value.replaces) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'replacement_mode=replace requires replaces',
        });
      }
      addDuplicateIssue(ctx, value.input_ids, ['input_ids']);
      addDuplicateIssue(
        ctx,
        (value.selected_result_inputs ?? []).map((input) => input.result_id),
        ['selected_result_inputs'],
      );
      const currentInputIds = new Set(value.input_ids);
      value.selected_result_inputs?.forEach((selected, index) => {
        if (currentInputIds.has(selected.result_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['selected_result_inputs', index, 'result_id'],
            message: 'A result id cannot be both a current and historical graph input',
          });
        }
      });
      if (
        value.input_ids.length + (value.selected_result_inputs?.length ?? 0) >
        AGENT_GRAPH_SCHEDULE_MAX_INPUT_IDS
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selected_result_inputs'],
          message: `Combined graph inputs must contain at most ${AGENT_GRAPH_SCHEDULE_MAX_INPUT_IDS} entries`,
        });
      }
    }),
);

const stopSchema = z
  .object({
    target_id: identitySchema,
    reason: z.string().trim().min(1).max(AGENT_GRAPH_SCHEDULE_MAX_REASON_CHARS),
  })
  .strip();

const finishSchema = z
  .object({
    result_ids: z
      .array(identitySchema)
      .min(1)
      .max(AGENT_GRAPH_SCHEDULE_MAX_RESULT_IDS)
      .describe('Committed graph record ids selected as the final result.'),
    reason: z.string().trim().min(1).max(AGENT_GRAPH_SCHEDULE_MAX_REASON_CHARS),
  })
  .strip()
  .superRefine((value, ctx) => addDuplicateIssue(ctx, value.result_ids, ['result_ids']));

const updateSchema = z.preprocess(
  cleanUpdateInput,
  z
    .object({
      operation: z
        .enum(['add_work', 'stop', 'finish'])
        .optional()
        .describe(
          'Explicit operation discriminator. Only the matching payload is applied; unrelated provider-filled optional payloads are ignored.',
        ),
      add_work: z
        .array(addWorkSchema)
        .max(AGENT_GRAPH_SCHEDULE_MAX_ADD_WORK)
        .optional()
        .describe(
          'Schedule work. For a new operator, prefer subagent_id from agent_list; legacy agent_id remains supported. Omit finish whenever add_work is present.',
        ),
      stop: z.array(stopSchema).max(AGENT_GRAPH_SCHEDULE_MAX_STOP).optional(),
      finish: finishSchema
        .optional()
        .describe(
          'Terminal operation selecting committed result ids. Use only after all work is done; never combine with add_work.',
        ),
    })
    .strip()
    .superRefine((value, ctx) => {
      const addWork = value.add_work ?? [];
      const stop = value.stop ?? [];
      if (
        addWork.reduce((count, work) => count + (work.selected_result_inputs?.length ?? 0), 0) >
        AGENT_GRAPH_SCHEDULE_MAX_SELECTED_RESULT_INPUTS
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['add_work'],
          message: `One graph update may select at most ${AGENT_GRAPH_SCHEDULE_MAX_SELECTED_RESULT_INPUTS} historical results`,
        });
      }
      if (value.operation) {
        const hasSelectedPayload =
          (value.operation === 'add_work' && addWork.length > 0) ||
          (value.operation === 'stop' && stop.length > 0) ||
          (value.operation === 'finish' && value.finish !== undefined);
        if (!hasSelectedPayload) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `operation=${value.operation} requires its matching payload`,
          });
        }
        addDuplicateIssue(
          ctx,
          stop.map((entry) => entry.target_id),
          ['stop'],
        );
        return;
      }
      if (addWork.length + stop.length + (value.finish ? 1 : 0) === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'At least one add_work, stop, or finish operation is required',
        });
      }
      if (value.finish && addWork.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'finish cannot be combined with add_work',
        });
      }
      addDuplicateIssue(
        ctx,
        stop.map((entry) => entry.target_id),
        ['stop'],
      );
    }),
);

const viewSchema = z.preprocess(
  cleanViewInput,
  z
    .object({
      mode: z
        .enum(['latest', 'page'])
        .optional()
        .describe(
          'Use latest for the current graph view. Use page only with an opaque cursor returned by a previous view.',
        ),
      cursor: cursorSchema
        .optional()
        .describe(
          'Opaque cursor returned by an earlier view_agent_graph call. Ignored when mode=latest.',
        ),
      historical_before_epoch: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Continue historical selected-result discovery before this epoch, using nextHistoricalBeforeEpoch from an earlier view.',
        ),
    })
    .strip()
    .superRefine((value, ctx) => {
      if (value.mode === 'page' && !value.cursor) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'mode=page requires cursor',
        });
      }
    }),
);

const yieldSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_GRAPH_SCHEDULE_MAX_REASON_CHARS)
      .describe('Why the supervisor has no immediate decision until the graph changes.'),
  })
  .strip();

function cleanAddWorkInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const cleaned = { ...(input as Record<string, unknown>) };
  if (cleaned.target_kind === 'new_agent') {
    delete cleaned.subagent_id;
    delete cleaned.operator_id;
  }
  if (cleaned.target_kind === 'new_preset') {
    delete cleaned.agent_id;
    delete cleaned.operator_id;
  }
  if (cleaned.target_kind === 'existing_operator') {
    delete cleaned.agent_id;
    delete cleaned.subagent_id;
  }
  if (cleaned.replacement_mode === 'none') delete cleaned.replaces;
  return cleaned;
}

function cleanUpdateInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const cleaned = { ...(input as Record<string, unknown>) };
  if (cleaned.operation === 'add_work') {
    delete cleaned.stop;
    delete cleaned.finish;
  } else if (cleaned.operation === 'stop') {
    delete cleaned.add_work;
    delete cleaned.finish;
  } else if (cleaned.operation === 'finish') {
    delete cleaned.add_work;
    delete cleaned.stop;
  }
  return cleaned;
}

function cleanViewInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const cleaned = { ...(input as Record<string, unknown>) };
  if (cleaned.mode === undefined || cleaned.mode === 'latest') delete cleaned.cursor;
  return cleaned;
}

export interface ViewAgentGraphToolInput {
  mode?: 'latest' | 'page';
  cursor?: string;
  historical_before_epoch?: number;
}

export interface UpdateAgentGraphToolInput {
  operation?: 'add_work' | 'stop' | 'finish';
  add_work?: Array<{
    target_kind?: 'new_agent' | 'new_preset' | 'existing_operator';
    agent_id?: string;
    subagent_id?: string;
    operator_id?: string;
    instruction: string;
    input_ids?: string[];
    selected_result_inputs?: Array<{
      source_graph_id: string;
      result_id: string;
    }>;
    replaces?: string;
    replacement_mode?: 'none' | 'replace';
  }>;
  stop?: Array<{
    target_id: string;
    reason: string;
  }>;
  finish?: {
    result_ids: string[];
    reason: string;
  };
}

export interface YieldAgentGraphToolInput {
  reason: string;
}

export interface AgentGraphScheduleWorkView extends AgentGraphScheduledWork {
  status: 'requested' | 'stopped' | 'superseded';
  updateId: string;
  revision: number;
  committedAt: number;
}

export interface AgentGraphStoppedTargetView extends AgentGraphStoppedTarget {
  updateId: string;
  revision: number;
  committedAt: number;
}

export interface AgentGraphScheduleFinishView extends AgentGraphScheduleFinish {
  updateId: string;
  revision: number;
  committedAt: number;
}

export interface AgentGraphScheduleProjection {
  schemaVersion: 1;
  graphId: string;
  revision: number;
  updateCount: number;
  closed: boolean;
  work: AgentGraphScheduleWorkView[];
  stoppedTargets: AgentGraphStoppedTargetView[];
  finish?: AgentGraphScheduleFinishView;
}

export interface AgentGraphToolScheduleView {
  closed: boolean;
  work: Array<
    Omit<AgentGraphScheduleWorkView, 'updateId' | 'revision'> & {
      instructionTruncated: boolean;
    }
  >;
  stoppedTargets: Array<Omit<AgentGraphStoppedTargetView, 'updateId' | 'revision'>>;
  finish?: Omit<AgentGraphScheduleFinishView, 'updateId' | 'revision'>;
  omittedTerminalWorkCount: number;
  omittedStoppedTargetCount: number;
}

export interface AgentGraphToolRuntimeOperatorView {
  operatorId: string;
  childSessionId: string;
  status: 'not_started' | AgentGraphActivationStatus;
  currentActivationId?: string;
  currentRunId?: string;
  lastEventTime?: number;
}

export interface AgentGraphToolReadinessView {
  operatorId: string;
  policyKind: 'map' | 'all_settled';
  status: 'waiting' | 'runnable';
  waitingFor: AgentGraphReadinessWait[];
}

export interface AgentGraphToolActivityView {
  recordId: string;
  operatorId: string;
  activationId: string;
  eventTime: number;
  facets: AgentGraphRecordFacet[];
  signals: AgentGraphSupervisorSignal[];
}

export interface AgentGraphToolRuntimeView {
  operators: AgentGraphToolRuntimeOperatorView[];
  readiness: AgentGraphToolReadinessView[];
  recentActivity: AgentGraphToolActivityView[];
  omittedTerminalOperatorCount: number;
  omittedActivityCount: number;
}

export interface AgentGraphSelectedResultInputView extends AgentGraphSelectedResultInput {}

export type ViewAgentGraphToolResult = {
  kind: 'agent_graph_view';
  schedule: AgentGraphToolScheduleView;
  runtime: AgentGraphToolRuntimeView;
  historicalSelectedResults: AgentGraphSelectedResultInputView[];
  nextHistoricalBeforeEpoch: number | null;
  nextCursor?: string;
};

export type UpdateAgentGraphToolResult = {
  kind: 'agent_graph_updated';
  schedule: AgentGraphToolScheduleView;
  runtime: AgentGraphToolRuntimeView;
  historicalSelectedResults: AgentGraphSelectedResultInputView[];
  nextHistoricalBeforeEpoch: number | null;
  nextCursor?: string;
};

/** Cooperative successful end-of-turn signal consumed by the Runtime tool loop. */
export type YieldAgentGraphToolResult = {
  kind: 'agent_graph_yielded';
  pendingWorkCount: number;
  liveOperatorCount: number;
  reason: string;
};

export interface AgentGraphYieldPermit {
  acquire(input: {
    scheduleRevision: number;
    observation: AgentGraphSupervisorObservation;
  }): Promise<boolean>;
  cancel(): void;
}

export interface BuildAgentGraphSupervisorToolsInput {
  graphId: string;
  scheduleStore: AgentGraphScheduleStore;
  observeGraph(): Promise<AgentGraphSupervisorObservation>;
  listHistoricalSelectedResults?(beforeEpoch?: number): Promise<{
    readonly results: readonly AgentGraphSelectedResultInput[];
    readonly nextBeforeEpoch: number | null;
  }>;
  /** Register before state reads so runtime/reconciliation transitions cannot escape yield admission. */
  prepareYieldPermit?(): AgentGraphYieldPermit;
  /** Host ownership check performed before append-only schedule admission. */
  authorizeScheduleUpdate?(request: AgentGraphScheduleUpdateRequest): unknown | Promise<unknown>;
  /**
   * Host lifecycle hook invoked after the schedule update is durable.
   *
   * The tool does not execute graph work itself. A host-owned coordinator can
   * use this notification to wake its single reconciliation driver.
   */
  onScheduleUpdateCommitted?(
    update: AgentGraphScheduleUpdate,
    authorization: unknown,
  ): void | Promise<void>;
}

/**
 * Builds the compact main-agent control surface for one host-bound graph.
 *
 * The update tool durably records schedule intent. A graph reconciler remains
 * responsible for turning those records into runtime start/stop actions.
 */
export function buildAgentGraphSupervisorTools(
  input: BuildAgentGraphSupervisorToolsInput,
): [
  MakaTool<ViewAgentGraphToolInput, ViewAgentGraphToolResult>,
  MakaTool<UpdateAgentGraphToolInput, UpdateAgentGraphToolResult>,
  MakaTool<YieldAgentGraphToolInput, YieldAgentGraphToolResult>,
] {
  const graphId = requireIdentity(input.graphId, 'graph id');
  const viewTool: MakaTool<ViewAgentGraphToolInput, ViewAgentGraphToolResult> = {
    name: VIEW_AGENT_GRAPH_TOOL_NAME,
    displayName: 'View agent graph',
    description:
      'Inspect the durable graph. Use mode=latest without a cursor for the current view; use mode=page only with a nextCursor returned by an earlier view.',
    parameters: viewSchema,
    categoryHint: 'read',
    nesting: 'direct_only',
    recoveryMode: 'replay_safe',
    impl: async (toolInput) => {
      const view = await readToolGraphView(
        input.scheduleStore,
        graphId,
        input.observeGraph,
        input.listHistoricalSelectedResults,
        toolInput.historical_before_epoch,
        resolveViewCursor(toolInput),
      );
      return {
        kind: 'agent_graph_view',
        ...view,
      };
    },
  };
  const updateTool: MakaTool<UpdateAgentGraphToolInput, UpdateAgentGraphToolResult> = {
    name: UPDATE_AGENT_GRAPH_TOOL_NAME,
    displayName: 'Update agent graph',
    description:
      'Adjust the graph durably. Always set operation. Prefer target_kind=new_preset with a user-approved subagent_id from agent_list; legacy agent_id remains supported. Unrelated provider-filled optional fields are ignored.',
    parameters: updateSchema,
    categoryHint: 'subagent',
    nesting: 'direct_only',
    recoveryMode: 'idempotent',
    impl: async (toolInput, context) => {
      const request = compileAgentGraphScheduleUpdate({
        graphId,
        input: toolInput,
        context,
      });
      const authorization = await input.authorizeScheduleUpdate?.(request);
      if (request.finish) {
        assertFinishResultsCommitted(graphId, request.finish.resultIds, await input.observeGraph());
      }
      const committed = await input.scheduleStore.commitAgentGraphScheduleUpdate(request);
      await input.onScheduleUpdateCommitted?.(committed.update, authorization);
      const view = await readToolGraphView(
        input.scheduleStore,
        graphId,
        input.observeGraph,
        input.listHistoricalSelectedResults,
        undefined,
        undefined,
      );
      return {
        kind: 'agent_graph_updated',
        ...view,
      };
    },
  };
  const yieldTool: MakaTool<YieldAgentGraphToolInput, YieldAgentGraphToolResult> = {
    name: YIELD_AGENT_GRAPH_TOOL_NAME,
    displayName: 'Yield agent graph',
    description:
      'End this supervisor turn successfully while scheduled graph work continues. Call this after the current scheduling wave has no immediate decision; do not poll, sleep, or emit a waiting message. The host will start a new supervisor turn at the next durable graph checkpoint. This does not finish or close the graph.',
    parameters: yieldSchema,
    categoryHint: 'subagent',
    recoveryMode: 'replay_safe',
    executionSemantics: 'exclusive_step',
    nesting: 'direct_only',
    impl: async ({ reason }) => {
      const permit = input.prepareYieldPermit?.();
      try {
        const [updates, observation] = await Promise.all([
          input.scheduleStore.listAgentGraphScheduleUpdates(graphId),
          input.observeGraph(),
        ]);
        assertGraphObservation(graphId, observation);
        const schedule = projectAgentGraphSchedule(graphId, updates);
        if (schedule.closed) {
          throw new Error('Agent graph is already finished; yield is no longer valid');
        }
        const pendingWorkCount = schedule.work.filter((work) => work.status === 'requested').length;
        if (pendingWorkCount === 0) {
          throw new Error('Agent graph has no pending scheduled work to yield for');
        }
        const liveOperatorCount = observation.projection.operators.filter(
          (operator) =>
            observation.projection.state.operators[operator.operatorId]?.status === 'running',
        ).length;
        const acquired = permit
          ? await permit.acquire({ scheduleRevision: schedule.revision, observation })
          : liveOperatorCount > 0;
        if (!acquired) {
          throw new Error(
            'Agent graph has no in-flight work or pending reconciliation that can produce a future supervisor checkpoint; inspect results and finish or update the graph instead',
          );
        }
        return {
          kind: 'agent_graph_yielded',
          pendingWorkCount,
          liveOperatorCount,
          reason,
        };
      } finally {
        permit?.cancel();
      }
    },
  };
  return [viewTool, updateTool, yieldTool];
}

function resolveViewCursor(input: ViewAgentGraphToolInput): string | undefined {
  if (input.mode === 'latest' || input.cursor === 'latest') return undefined;
  return input.cursor;
}

export function compileAgentGraphScheduleUpdate(input: {
  graphId: string;
  input: UpdateAgentGraphToolInput;
  context: Pick<
    MakaToolContext,
    'sessionId' | 'runId' | 'turnId' | 'toolCallId' | 'orchestrationMode'
  >;
}): AgentGraphScheduleUpdateRequest {
  const graphId = requireIdentity(input.graphId, 'graph id');
  const parsed = updateSchema.parse(input.input);
  const runId = requireIdentity(input.context.runId, 'source run id');
  const source = {
    sessionId: requireIdentity(input.context.sessionId, 'source session id'),
    runId,
    turnId: requireIdentity(input.context.turnId, 'source turn id'),
    toolCallId: requireIdentity(input.context.toolCallId, 'source tool call id'),
    orchestrationMode:
      input.context.orchestrationMode === 'swarm' ? ('swarm' as const) : ('graph' as const),
  };
  const addWorkInput =
    parsed.operation === undefined || parsed.operation === 'add_work'
      ? (parsed.add_work ?? [])
      : [];
  const stopInput =
    parsed.operation === undefined || parsed.operation === 'stop' ? (parsed.stop ?? []) : [];
  const updateHash = stableHash({
    schemaVersion: AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION,
    graphId,
    source,
  });
  const updateId = `graph_update_${updateHash.slice('sha256:'.length, 'sha256:'.length + 32)}`;
  const addWork = addWorkInput.map((work, index): AgentGraphScheduledWork => {
    const target = normalizeWorkTarget(work);
    const inputIds = normalizeUniqueIdentities(work.input_ids, 'input id');
    const selectedResultInputs: AgentGraphSelectedResultInput[] = (
      work.selected_result_inputs ?? []
    ).map((input) => ({
      sourceGraphId: requireIdentity(input.source_graph_id, 'source graph id'),
      resultId: requireIdentity(input.result_id, 'selected result id'),
    }));
    const workHash = stableHash({
      schemaVersion: AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION,
      updateId,
      index,
    });
    return {
      workId: `graph_work_${workHash.slice('sha256:'.length, 'sha256:'.length + 32)}`,
      target,
      instruction: requireText(
        work.instruction,
        AGENT_GRAPH_SCHEDULE_MAX_INSTRUCTION_CHARS,
        'instruction',
      ),
      inputIds,
      ...(selectedResultInputs.length > 0 ? { selectedResultInputs } : {}),
      ...(work.replaces && work.replacement_mode !== 'none'
        ? { replaces: requireIdentity(work.replaces, 'replacement target id') }
        : {}),
    };
  });
  const stop = stopInput
    .map(
      (entry): AgentGraphStoppedTarget => ({
        targetId: requireIdentity(entry.target_id, 'stop target id'),
        reason: requireText(entry.reason, AGENT_GRAPH_SCHEDULE_MAX_REASON_CHARS, 'stop reason'),
      }),
    )
    .sort((a, b) => compareIdentity(a.targetId, b.targetId));
  ensureUnique(
    stop.map((entry) => entry.targetId),
    'stop target id',
  );
  const finish =
    parsed.finish && (parsed.operation === undefined || parsed.operation === 'finish')
      ? {
          resultIds: normalizeUniqueIdentities(parsed.finish.result_ids, 'finish result id'),
          reason: requireText(
            parsed.finish.reason,
            AGENT_GRAPH_SCHEDULE_MAX_REASON_CHARS,
            'finish reason',
          ),
        }
      : undefined;
  const semantic = {
    schemaVersion: AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION,
    updateId,
    graphId,
    source,
    addWork,
    stop,
    ...(finish ? { finish } : {}),
  };
  return {
    ...semantic,
    updateFingerprint: stableHash(semantic),
  };
}

export function projectAgentGraphSchedule(
  graphId: string,
  values: readonly AgentGraphScheduleUpdate[],
): AgentGraphScheduleProjection {
  const expectedGraphId = requireIdentity(graphId, 'graph id');
  const updates = values
    .map(decodeAgentGraphScheduleUpdate)
    .sort((a, b) => a.revision - b.revision || compareIdentity(a.updateId, b.updateId));
  const work: AgentGraphScheduleWorkView[] = [];
  const stoppedTargets = new Map<string, AgentGraphStoppedTargetView>();
  const workIds = new Set<string>();
  const supersededTargetIds = new Set<string>();
  let finish: AgentGraphScheduleFinishView | undefined;
  updates.forEach((update, index) => {
    if (update.graphId !== expectedGraphId) {
      throw new Error(
        `Agent graph schedule update ${update.updateId} belongs to ${update.graphId}, expected ${expectedGraphId}`,
      );
    }
    if (update.revision !== index + 1) {
      throw new Error(
        `Agent graph schedule ${expectedGraphId} has non-contiguous revision ${update.revision}`,
      );
    }
    if (finish) {
      throw new Error(`Agent graph schedule ${expectedGraphId} has updates after finish`);
    }
    for (const item of update.addWork) {
      if (workIds.has(item.workId)) {
        throw new Error(`Agent graph schedule repeats work ${item.workId}`);
      }
      workIds.add(item.workId);
      if (item.replaces) supersededTargetIds.add(item.replaces);
      work.push({
        ...item,
        target: { ...item.target },
        inputIds: [...item.inputIds],
        ...(item.selectedResultInputs
          ? { selectedResultInputs: item.selectedResultInputs.map((input) => ({ ...input })) }
          : {}),
        status: 'requested',
        updateId: update.updateId,
        revision: update.revision,
        committedAt: update.committedAt,
      });
    }
    for (const stopped of update.stop) {
      stoppedTargets.set(stopped.targetId, {
        ...stopped,
        updateId: update.updateId,
        revision: update.revision,
        committedAt: update.committedAt,
      });
    }
    if (update.finish) {
      finish = {
        resultIds: [...update.finish.resultIds],
        reason: update.finish.reason,
        updateId: update.updateId,
        revision: update.revision,
        committedAt: update.committedAt,
      };
    }
  });
  for (const item of work) {
    if (stoppedTargets.has(item.workId)) item.status = 'stopped';
    else if (supersededTargetIds.has(item.workId)) item.status = 'superseded';
  }
  return {
    schemaVersion: 1,
    graphId: expectedGraphId,
    revision: updates.at(-1)?.revision ?? 0,
    updateCount: updates.length,
    closed: finish !== undefined,
    work,
    stoppedTargets: [...stoppedTargets.values()].sort(
      (a, b) => a.revision - b.revision || compareIdentity(a.targetId, b.targetId),
    ),
    ...(finish ? { finish } : {}),
  };
}

function agentGraphToolScheduleView(
  projection: AgentGraphScheduleProjection,
  livePage: AgentGraphLiveStatePage,
): AgentGraphToolScheduleView {
  const liveWork = projection.work.filter(
    (item) => item.status === 'requested' && livePage.workIds.has(item.workId),
  );
  const terminalWork = projection.work.filter((item) => item.status !== 'requested');
  const visibleTerminalWork = terminalWork.slice(-TOOL_VIEW_MAX_TERMINAL_WORK);
  const work = [...liveWork, ...visibleTerminalWork].map((item) => {
    const instructionTruncated = item.instruction.length > TOOL_VIEW_MAX_INSTRUCTION_CHARS;
    return {
      ...item,
      target: { ...item.target },
      inputIds: [...item.inputIds],
      ...(item.selectedResultInputs
        ? { selectedResultInputs: item.selectedResultInputs.map((input) => ({ ...input })) }
        : {}),
      instruction: instructionTruncated
        ? `${item.instruction.slice(0, TOOL_VIEW_MAX_INSTRUCTION_CHARS)}…`
        : item.instruction,
      instructionTruncated,
    };
  });
  const stoppedTargets = projection.stoppedTargets.slice(-TOOL_VIEW_MAX_STOPPED_TARGETS);
  return {
    closed: projection.closed,
    work: work.map(({ updateId: _updateId, revision: _revision, ...entry }) => entry),
    stoppedTargets: stoppedTargets.map(
      ({ updateId: _updateId, revision: _revision, ...entry }) => ({ ...entry }),
    ),
    omittedTerminalWorkCount: terminalWork.length - visibleTerminalWork.length,
    omittedStoppedTargetCount: projection.stoppedTargets.length - stoppedTargets.length,
    ...(projection.finish
      ? {
          finish: (({ updateId: _updateId, revision: _revision, ...entry }) => ({
            ...entry,
            resultIds: [...entry.resultIds],
          }))({
            ...projection.finish,
            resultIds: [...projection.finish.resultIds],
          }),
        }
      : {}),
  };
}

async function readToolGraphView(
  store: AgentGraphScheduleStore,
  graphId: string,
  observeGraph: () => Promise<AgentGraphSupervisorObservation>,
  listHistoricalSelectedResults:
    | ((beforeEpoch?: number) => Promise<{
        readonly results: readonly AgentGraphSelectedResultInput[];
        readonly nextBeforeEpoch: number | null;
      }>)
    | undefined,
  historicalBeforeEpoch: number | undefined,
  cursor: string | undefined,
): Promise<{
  schedule: AgentGraphToolScheduleView;
  runtime: AgentGraphToolRuntimeView;
  historicalSelectedResults: AgentGraphSelectedResultInputView[];
  nextHistoricalBeforeEpoch: number | null;
  nextCursor?: string;
}> {
  const [updates, observation, historicalPage] = await Promise.all([
    store.listAgentGraphScheduleUpdates(graphId),
    observeGraph(),
    listHistoricalSelectedResults?.(historicalBeforeEpoch) ?? {
      results: [],
      nextBeforeEpoch: null,
    },
  ]);
  assertGraphObservation(graphId, observation);
  const projection = projectAgentGraphSchedule(graphId, updates);
  const livePage = paginateAgentGraphLiveState(projection, observation, cursor);
  return {
    schedule: agentGraphToolScheduleView(projection, livePage),
    runtime: agentGraphToolRuntimeView(observation, livePage),
    historicalSelectedResults: historicalPage.results
      .slice(0, TOOL_VIEW_MAX_HISTORICAL_RESULTS)
      .map((selected) => ({ ...selected })),
    nextHistoricalBeforeEpoch: historicalPage.nextBeforeEpoch,
    ...(livePage.nextCursor ? { nextCursor: livePage.nextCursor } : {}),
  };
}

function agentGraphToolRuntimeView(
  observation: AgentGraphSupervisorObservation,
  livePage: AgentGraphLiveStatePage,
): AgentGraphToolRuntimeView {
  const operatorViews = observation.projection.operators.map(
    (binding): AgentGraphToolRuntimeOperatorView => {
      const state = observation.projection.state.operators[binding.operatorId];
      return {
        operatorId: binding.operatorId,
        childSessionId: binding.sessionId,
        status: state?.status ?? 'not_started',
        ...(state
          ? {
              currentActivationId: state.currentActivationId,
              currentRunId: state.activations[state.currentActivationId]?.agentRunId,
              lastEventTime: state.activations[state.currentActivationId]?.lastEventTime,
            }
          : {}),
      };
    },
  );
  const liveOperators = operatorViews.filter(
    (entry) =>
      (entry.status === 'not_started' || entry.status === 'running') &&
      livePage.operatorIds.has(entry.operatorId),
  );
  const terminalOperators = operatorViews.filter(
    (entry) => entry.status !== 'not_started' && entry.status !== 'running',
  );
  const visibleTerminalOperators = terminalOperators.slice(-TOOL_VIEW_MAX_TERMINAL_OPERATORS);
  const readinessEntries = observation.readiness.supervisorView.filter((entry) =>
    livePage.readinessIds.has(entry.readinessId),
  );
  const readiness = readinessEntries.map((entry) => ({
    operatorId: entry.operatorId,
    policyKind: entry.policyKind,
    status: entry.status,
    waitingFor: entry.waitingFor.map(cloneReadinessWait),
  }));
  const activity = observation.projection.supervisorMetaStream;
  const recentActivity = activity.slice(-TOOL_VIEW_MAX_ACTIVITY).map((entry) => ({
    recordId: entry.recordId,
    operatorId: entry.operatorId,
    activationId: entry.activationId,
    eventTime: entry.eventTime,
    facets: [...entry.facets],
    signals: entry.signals.map((signal) => ({ ...signal })),
  }));
  return {
    operators: [...liveOperators, ...visibleTerminalOperators],
    readiness,
    recentActivity,
    omittedTerminalOperatorCount: terminalOperators.length - visibleTerminalOperators.length,
    omittedActivityCount: activity.length - recentActivity.length,
  };
}

interface AgentGraphLiveStatePage {
  workIds: Set<string>;
  operatorIds: Set<string>;
  readinessIds: Set<string>;
  nextCursor?: string;
}

type AgentGraphLiveStateEntry =
  | {
      kind: 'work';
      id: string;
      cursor: string;
    }
  | {
      kind: 'operator';
      id: string;
      cursor: string;
    }
  | {
      kind: 'readiness';
      id: string;
      cursor: string;
    };

function paginateAgentGraphLiveState(
  projection: AgentGraphScheduleProjection,
  observation: AgentGraphSupervisorObservation,
  cursor: string | undefined,
): AgentGraphLiveStatePage {
  const entries: AgentGraphLiveStateEntry[] = [
    ...projection.work
      .filter((item) => item.status === 'requested')
      .map((item) => ({
        kind: 'work' as const,
        id: item.workId,
        cursor: `work:${item.workId}`,
      })),
    ...observation.projection.operators
      .filter((binding) => {
        const status = observation.projection.state.operators[binding.operatorId]?.status;
        return status === undefined || status === 'running';
      })
      .map((binding) => ({
        kind: 'operator' as const,
        id: binding.operatorId,
        cursor: `operator:${binding.operatorId}`,
      })),
    ...observation.readiness.supervisorView.map((entry) => ({
      kind: 'readiness' as const,
      id: entry.readinessId,
      cursor: `readiness:${entry.readinessId}`,
    })),
  ];
  ensureUnique(
    entries.map((entry) => entry.cursor),
    'live-state cursor',
  );
  const cursorIndex = cursor ? entries.findIndex((entry) => entry.cursor === cursor) : -1;
  if (cursor && cursorIndex < 0) {
    throw new Error('Agent graph view cursor is stale or invalid');
  }
  const start = cursorIndex + 1;
  const visible = entries.slice(start, start + TOOL_VIEW_MAX_LIVE_STATE);
  const workIds = new Set<string>();
  const operatorIds = new Set<string>();
  const readinessIds = new Set<string>();
  for (const entry of visible) {
    if (entry.kind === 'work') workIds.add(entry.id);
    else if (entry.kind === 'operator') operatorIds.add(entry.id);
    else readinessIds.add(entry.id);
  }
  const hasMore = start + visible.length < entries.length;
  return {
    workIds,
    operatorIds,
    readinessIds,
    ...(hasMore && visible.length > 0 ? { nextCursor: visible[visible.length - 1]!.cursor } : {}),
  };
}

function assertFinishResultsCommitted(
  graphId: string,
  resultIds: readonly string[],
  observation: AgentGraphSupervisorObservation,
): void {
  assertGraphObservation(graphId, observation);
  const committedRecordIds = new Set(
    observation.projection.records
      .filter((record) => record.graphId === graphId)
      .map((record) => record.recordId),
  );
  const missing = resultIds.filter((resultId) => !committedRecordIds.has(resultId));
  if (missing.length > 0) {
    throw new Error(
      `Agent graph finish result ids are not committed graph records: ${missing.join(', ')}`,
    );
  }
}

function assertGraphObservation(
  graphId: string,
  observation: AgentGraphSupervisorObservation,
): void {
  if (
    observation.projection.graphId !== graphId ||
    observation.readiness.graphId !== graphId ||
    observation.readiness.trace.graphId !== graphId
  ) {
    throw new Error('Agent graph supervisor observation belongs to another graph');
  }
}

function normalizeWorkTarget(input: {
  target_kind?: 'new_agent' | 'new_preset' | 'existing_operator';
  agent_id?: string;
  subagent_id?: string;
  operator_id?: string;
}): AgentGraphWorkTarget {
  if (input.target_kind === 'new_agent') {
    return { kind: 'agent', agentId: requireIdentity(input.agent_id, 'agent id') };
  }
  if (input.target_kind === 'new_preset') {
    return { kind: 'preset', presetId: requireIdentity(input.subagent_id, 'subagent preset id') };
  }
  if (input.target_kind === 'existing_operator') {
    return {
      kind: 'operator',
      operatorId: requireIdentity(input.operator_id, 'operator id'),
    };
  }
  const count =
    (input.agent_id ? 1 : 0) + (input.subagent_id ? 1 : 0) + (input.operator_id ? 1 : 0);
  if (count !== 1) {
    throw new Error('Exactly one of subagent_id, agent_id, or operator_id is required');
  }
  if (input.subagent_id) {
    return { kind: 'preset', presetId: requireIdentity(input.subagent_id, 'subagent preset id') };
  }
  return input.agent_id
    ? { kind: 'agent', agentId: requireIdentity(input.agent_id, 'agent id') }
    : { kind: 'operator', operatorId: requireIdentity(input.operator_id, 'operator id') };
}

function normalizeUniqueIdentities(values: readonly string[] | undefined, name: string): string[] {
  if (!values) return [];
  const normalized = values.map((value) => requireIdentity(value, name)).sort(compareIdentity);
  ensureUnique(normalized, name);
  return normalized;
}

function cloneReadinessWait(wait: AgentGraphReadinessWait): AgentGraphReadinessWait {
  return wait.kind === 'input_route'
    ? { ...wait, upstreamOperatorIds: [...wait.upstreamOperatorIds] }
    : { ...wait };
}

function ensureUnique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Agent graph schedule repeats ${name}`);
  }
}

function requireIdentity(value: string | undefined, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid agent graph ${name}`);
  }
  return value;
}

function requireText(value: string, maxChars: number, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxChars ||
    value.trim() !== value ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid agent graph ${name}`);
  }
  return value;
}

function compareIdentity(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function addDuplicateIssue(
  ctx: z.RefinementCtx,
  values: readonly string[],
  path: Array<string | number>,
): void {
  if (new Set(values).size === values.length) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: 'Duplicate identities are not allowed',
  });
}
