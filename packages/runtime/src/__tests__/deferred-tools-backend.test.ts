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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader } from '@maka/core/session';
import type { RunTraceEvent } from '../run-trace.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';

import { AiSdkBackend } from '../ai-sdk-backend.js';
import type { MakaTool } from '../tool-runtime.js';
import {
  ToolAvailabilityRuntime,
  LOAD_TOOLS_NAME,
  type ToolAvailabilityConfig,
} from '../tool-availability.js';
import { toolSchemaCharsForDiagnostics } from '../request-shape.js';
import {
  LOCAL_READ_AGENT_ID,
  LOCAL_READ_AGENT_PROFILE,
  requireBuiltinAgentDefinitionByProfile,
} from '../agent-catalog.js';
import {
  AGENT_LIST_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
  AGENT_SPAWN_TOOL_NAME,
  AGENT_TOOL_NAMES,
  buildParentAgentTools,
} from '../subagent-tools.js';
import { buildDeferredToolGroupsFromCatalog } from '../tool-catalog-derive.js';
import { createDurableTurnHarness, drainWithDurableTurn } from './durable-turn-harness.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';

// End-to-end through the live AiSdkBackend: the availability config drives the
// between-request activation, the durable seed reconstructs prior-turn
// loads, and the execute-boundary guard is fed by the live snapshot.

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const config: ToolAvailabilityConfig = {
  economy: true,
  groups: [{ id: 'browser', toolNames: ['browser_click'], label: 'Browser automation' }],
};

const agentConfig: ToolAvailabilityConfig = {
  economy: true,
  groups: buildDeferredToolGroupsFromCatalog('cli', AGENT_TOOL_NAMES),
};

function tools(implCalls: string[]): MakaTool[] {
  return [
    {
      name: 'Read',
      description: 'Read',
      parameters: z.object({ path: z.string().optional() }),
      impl: () => ({ ok: true }),
    },
    {
      name: 'browser_click',
      description: 'Click in the browser',
      parameters: z.object({}),
      impl: () => {
        implCalls.push('browser_click');
        return { ok: true };
      },
    },
  ];
}

interface SendDiagnostics {
  promptSegments?: readonly { kind: string; chars?: number }[];
  contextBudget?: Record<string, unknown>;
  requestShapeHash?: string;
  requestShapeChangeReason?: string;
}

interface BackendOpts {
  /** Override the availability config (pass `null` to omit it ⇒ full surface). */
  toolAvailability?: ToolAvailabilityConfig | null;
  /** Terminal send diagnostics, read off the run trace (#1679). */
  recordSendDiagnostics?: (record: SendDiagnostics) => void;
  durable?: ReturnType<typeof createDurableTurnHarness>;
  extraTools?: readonly MakaTool[];
}

function backend(
  model: MockLanguageModelV4,
  implCalls: string[],
  opts: BackendOpts = {},
): AiSdkBackend {
  let n = 0;
  const resolved = opts.toolAvailability === null ? undefined : (opts.toolAvailability ?? config);
  return createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async () => {},
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    tools: tools(implCalls),
    ...(opts.durable ? { loadTurnRuntimeEvents: opts.durable.loadTurnRuntimeEvents } : {}),
    ...(resolved ? { toolAvailability: resolved } : {}),
    ...(opts.recordSendDiagnostics
      ? {
          recordRunTrace: (event: RunTraceEvent) => {
            if (event.type === 'send_diagnostics_recorded') {
              opts.recordSendDiagnostics?.(event.data as SendDiagnostics);
            }
          },
        }
      : {}),
    newId: () => `id-${++n}`,
    now: () => 1,
  });
}

function agentBackend(
  model: MockLanguageModelV4,
  spawnCalls: unknown[],
  opts: BackendOpts & { permissionMode?: SessionHeader['permissionMode'] } = {},
): AiSdkBackend {
  let n = 0;
  const resolved =
    opts.toolAvailability === null ? undefined : (opts.toolAvailability ?? agentConfig);
  return createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(opts.permissionMode),
    appendMessage: async () => {},
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    tools: [...buildParentAgentTools(), ...(opts.extraTools ?? [])],
    ...(opts.durable ? { loadTurnRuntimeEvents: opts.durable.loadTurnRuntimeEvents } : {}),
    ...(resolved ? { toolAvailability: resolved } : {}),
    spawnChildSession: async (input) => {
      const childIndex = spawnCalls.length;
      spawnCalls.push(input);
      const definition = requireBuiltinAgentDefinitionByProfile(input.agentProfile);
      return {
        childSessionId: `child-session-${childIndex}`,
        agentId: definition.id,
        agentName: definition.name,
        runId: `child-run-${childIndex}`,
        turnId: `child-turn-${childIndex}`,
        status: 'completed',
        permissionMode: 'explore',
        summary: 'done',
        artifactIds: [],
      };
    },
    listChildAgents: async () => ({ definitions: [], runs: [] }),
    readChildAgentOutput: async (input) => ({ requested: input }),
    ...(opts.recordSendDiagnostics
      ? {
          recordRunTrace: (event: RunTraceEvent) => {
            if (event.type === 'send_diagnostics_recorded') {
              opts.recordSendDiagnostics?.(event.data as SendDiagnostics);
            }
          },
        }
      : {}),
    newId: () => `id-${++n}`,
    now: () => 1,
  });
}

describe('AiSdkBackend deferred tool loading', () => {
  test('step 0 hides an unloaded group tool but advertises load_tools', async () => {
    const captured: string[][] = [];
    const implCalls: string[] = [];
    await drain(
      backend(capturingModel(captured), implCalls).send({
        turnId: 'turn-1',
        text: 'hi',
        context: [],
      }),
    );
    assert.ok(captured[0].includes('Read'), 'ungrouped Read advertised');
    assert.ok(captured[0].includes(LOAD_TOOLS_NAME), 'load_tools advertised');
    assert.ok(!captured[0].includes('browser_click'), 'unloaded browser_click hidden');
  });

  test('durable seed: a prior-turn load re-advertises the tool at the next turn', async () => {
    const captured: string[][] = [];
    const implCalls: string[] = [];
    await drain(
      backend(capturingModel(captured), implCalls).send({
        turnId: 'turn-2',
        text: 'click it',
        context: [],
        runtimeContext: priorBrowserLoad('turn-1'),
      }),
    );
    assert.ok(
      captured[0].includes('browser_click'),
      'browser_click must be advertised at turn 2 step 0 because it was loaded in turn 1',
    );
  });

  test('guard: same-step parallel load_tools(browser)+browser_click rejects the click (live)', async () => {
    const durable = createDurableTurnHarness({
      turnId: 'turn-1',
      text: 'load and click in one step',
    });
    const captured: string[][] = [];
    const implCalls: string[] = [];
    await drainWithDurableTurn(
      backend(parallelLoadUseModel(captured), implCalls, { durable }).send(durable.sendInput()),
      durable,
    );
    assert.equal(captured.length, 2, 'expected two steps (parallel call step, then a final step)');
    assert.ok(!captured[0].includes('browser_click'), 'browser_click is not advertised at step 0');
    assert.deepEqual(
      implCalls,
      [],
      'the real browser_click impl must never run when it was used before activation',
    );
  });

  test('diagnostics: a same-turn load is reflected in the recorded tool-schema cost', async () => {
    const durable = createDurableTurnHarness({
      turnId: 'turn-1',
      text: 'load browser',
    });
    const records: SendDiagnostics[] = [];
    const implCalls: string[] = [];
    // Step 0 loads browser; browser_click activates in request 1.
    await drainWithDurableTurn(
      backend(loadBrowserThenFinishModel(), implCalls, {
        recordSendDiagnostics: (r) => records.push(r),
        durable,
      }).send(durable.sendInput()),
      durable,
    );

    assert.equal(records.length, 1, 'exactly one llm-call cost record for the turn');
    const toolSeg = records[0]?.promptSegments?.find((s) => s.kind === 'tool_schema');
    assert.ok(toolSeg, 'a tool_schema prompt segment was recorded');

    // The recorded cost must reflect the FINAL active set (Read + load_tools +
    // browser_click), not the lean step-0 set — otherwise the load turn
    // under-reports the heavy schema it actually sent on step 1. Use the real
    // runtime so the provider tool set (incl. the connector) matches the backend.
    const providerTools = new ToolAvailabilityRuntime(tools([]), config, INVALID_FIXTURE).prepare(
      [],
    ).providerTools;
    const leanChars = toolSchemaCharsForDiagnostics(providerTools, ['Read', LOAD_TOOLS_NAME]);
    const loadedChars = toolSchemaCharsForDiagnostics(providerTools, [
      'Read',
      LOAD_TOOLS_NAME,
      'browser_click',
    ]);
    assert.ok(loadedChars > leanChars, 'sanity: the loaded set is heavier than the lean set');
    assert.equal(
      toolSeg.chars,
      loadedChars,
      'recorded tool-schema chars include the loaded browser_click',
    );
    assert.equal(
      records[0]?.requestShapeChangeReason,
      'first_turn',
      'first turn establishes the baseline; the expansion sets the durable prefix for next turn',
    );
  });

  test('high-water "after" hash stays consistent with the final recorded requestShapeHash across a same-turn load', async () => {
    const records: SendDiagnostics[] = [];
    const implCalls: string[] = [];
    const be = backend(loadBrowserThenFinishModel(), implCalls, {
      recordSendDiagnostics: (r) => records.push(r),
    });
    // Real high-water reasons only arise from the synthesis-cache subsystem
    // (selectSynthesisCacheForReplay needs valid cache blocks + matching
    // history). Inject just the marker by wrapping buildPriorMessages so this
    // targets the diagnostics-consistency invariant, not that subsystem.
    type PriorReplayish = { contextBudget?: Record<string, unknown> };
    const patch = be as unknown as {
      buildPriorMessages: (scope: unknown, input: unknown) => Promise<PriorReplayish>;
    };
    const realBuildPriorMessages = patch.buildPriorMessages.bind(be);
    patch.buildPriorMessages = async (scope: unknown, input: unknown) => {
      const prior = await realBuildPriorMessages(scope, input);
      return {
        ...prior,
        contextBudget: {
          ...(prior.contextBudget ?? {}),
          highWaterReason: 'synthesis_cache_select',
        },
      };
    };

    await drain(be.send({ turnId: 'turn-1', text: 'load browser', context: [] }));

    assert.equal(records.length, 1, 'one llm-call record for the turn');
    const cb = records[0]?.contextBudget;
    assert.ok(cb?.highWaterRequestShapeHashAfter, 'a high-water "after" hash was recorded');
    // The same-turn load makes the final active set differ from step-0, so this
    // equality fails if "after" is left at the step-0 hash (the bug).
    assert.equal(
      cb.highWaterRequestShapeHashAfter,
      records[0]?.requestShapeHash,
      'high-water "after" must equal the final recorded requestShapeHash',
    );
    assert.equal(
      cb.highWaterRequestShapeHashBefore,
      undefined,
      'first turn has no pre-turn baseline',
    );
  });

  test('economy off: every tool stays advertised, no connector', async () => {
    const captured: string[][] = [];
    const implCalls: string[] = [];
    // economy off ⇒ the contract is "advertise everything", no load_tools.
    await drain(
      backend(capturingModel(captured), implCalls, { toolAvailability: null }).send({
        turnId: 'turn-1',
        text: 'hi',
        context: [],
      }),
    );
    assert.ok(
      captured[0].includes('browser_click'),
      'a group tool is advertised when economy is off',
    );
    assert.ok(!captured[0].includes(LOAD_TOOLS_NAME), 'no connector in full mode');
  });

  test('repair: a mis-cased group call after a mid-turn load repairs to the canonical name', async () => {
    const durable = createDurableTurnHarness({
      turnId: 'turn-1',
      text: 'load browser then click',
    });
    const captured: string[][] = [];
    const implCalls: string[] = [];
    await drainWithDurableTurn(
      backend(loadThenMiscasedClickModel(captured), implCalls, { durable }).send(
        durable.sendInput(),
      ),
      durable,
    );
    // Step 0 loads browser; step 1 emits the mis-cased BROWSER_CLICK. Because the
    // repair list follows the current step's active snapshot (not the frozen
    // step-0 set), the call repairs to canonical browser_click and runs — rather
    // than routing to `invalid`, which would leave implCalls empty.
    assert.ok(captured.length >= 2, 'expected at least the load step and the click step');
    assert.ok(
      captured[1].includes('browser_click'),
      'browser_click is advertised at step 1 after the load',
    );
    assert.deepEqual(
      implCalls,
      ['browser_click'],
      'the mis-cased call repaired to browser_click and ran',
    );
  });
});

describe('AiSdkBackend deferred agent tools', () => {
  test('Swarm Mode injects the async prompt and pins durable swarm controls at step 0', async () => {
    const capturedTools: string[][] = [];
    const capturedPrompts: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ tools: stepTools, prompt }) => {
        capturedTools.push((stepTools ?? []).map((tool) => tool.name));
        capturedPrompts.push(JSON.stringify(prompt));
        return {
          stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: ZERO_USAGE,
            },
          ]),
        };
      },
    });

    await drain(
      agentBackend(model, [], {
        extraTools: ['update_agent_graph', 'yield_agent_graph', 'agent_swarm_status'].map(
          (name) => ({
            name,
            description: name,
            parameters: z.object({}),
            impl: () => ({ ok: true }),
          }),
        ),
      }).send({
        turnId: 'turn-swarm-mode',
        text: 'fan out',
        context: [],
        orchestration: {
          mode: 'swarm',
          source: 'turn_override',
          agentSwarmAuthorization: 'turn_override',
        },
      }),
    );

    assert.ok(capturedTools[0]?.includes('agent_list'));
    assert.ok(capturedTools[0]?.includes('update_agent_graph'));
    assert.ok(capturedTools[0]?.includes('yield_agent_graph'));
    assert.ok(capturedTools[0]?.includes('agent_swarm_status'));
    assert.ok(capturedTools[0]?.includes('agent_output'));
    assert.ok(!capturedTools[0]?.includes('agent_swarm'));
    assert.match(capturedPrompts[0] ?? '', /Orchestration Mode: Swarm/);
    assert.match(capturedPrompts[0] ?? '', /preferred execution strategy/);
    assert.match(capturedPrompts[0] ?? '', /You may continue directly/);
    assert.match(capturedPrompts[0] ?? '', /Do not poll, sleep, watch child logs/);
  });

  test('Graph Mode injects the supervisor prompt and pins controls plus agent output at step 0', async () => {
    const capturedTools: string[][] = [];
    const capturedPrompts: string[] = [];
    const graphTools: MakaTool[] = [
      {
        name: 'view_agent_graph',
        description: 'View graph',
        parameters: z.object({}),
        impl: () => ({ ok: true }),
      },
      {
        name: 'update_agent_graph',
        description: 'Update graph',
        parameters: z.object({}),
        impl: () => ({ ok: true }),
      },
      {
        name: 'yield_agent_graph',
        description: 'Yield graph',
        parameters: z.object({}),
        impl: () => ({ ok: true }),
      },
    ];
    const model = new MockLanguageModelV4({
      doStream: async ({ tools: stepTools, prompt }) => {
        capturedTools.push((stepTools ?? []).map((tool) => tool.name));
        capturedPrompts.push(JSON.stringify(prompt));
        return {
          stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: ZERO_USAGE,
            },
          ]),
        };
      },
    });

    const backend = agentBackend(model, [], {
      extraTools: graphTools,
    });
    await drain(
      backend.send({
        turnId: 'turn-graph-mode',
        text: 'coordinate the graph',
        context: [],
        orchestration: {
          mode: 'graph',
          source: 'turn_override',
          agentSwarmAuthorization: 'none',
        },
      }),
    );

    assert.ok(capturedTools[0]?.includes(AGENT_LIST_TOOL_NAME));
    assert.ok(capturedTools[0]?.includes('view_agent_graph'));
    assert.ok(capturedTools[0]?.includes('update_agent_graph'));
    assert.ok(capturedTools[0]?.includes('yield_agent_graph'));
    assert.ok(capturedTools[0]?.includes(AGENT_OUTPUT_TOOL_NAME));
    assert.match(capturedPrompts[0] ?? '', /Orchestration Mode: Graph/);
    assert.match(capturedPrompts[0] ?? '', /supervisor beside the data path/);
  });

  test('agent tools are hidden by default and visible after load_tools(agent)', async () => {
    const durable = createDurableTurnHarness({ turnId: 'turn-1', text: 'load agents' });
    const captured: string[][] = [];
    const spawnCalls: unknown[] = [];
    await drainWithDurableTurn(
      agentBackend(loadAgentThenFinishModel(captured), spawnCalls, { durable }).send(
        durable.sendInput({ runId: 'parent-run' }),
      ),
      durable,
    );

    assert.ok(captured[0].includes(LOAD_TOOLS_NAME), 'load_tools advertised');
    assert.ok(!captured[0].includes(AGENT_SPAWN_TOOL_NAME), 'agent_spawn hidden at step 0');
    assert.ok(!captured[0].includes('agent_swarm'), 'agent_swarm removed at step 0');
    assert.ok(!captured[0].includes(AGENT_LIST_TOOL_NAME), 'agent_list hidden at step 0');
    assert.ok(!captured[0].includes(AGENT_OUTPUT_TOOL_NAME), 'agent_output hidden at step 0');

    assert.ok(
      captured[1].includes(AGENT_SPAWN_TOOL_NAME),
      'agent_spawn visible after loading the agent group',
    );
    assert.ok(!captured[1].includes('agent_swarm'), 'agent_swarm stays removed after loading');
    assert.ok(
      captured[1].includes(AGENT_LIST_TOOL_NAME),
      'agent_list visible after loading the agent group',
    );
    assert.ok(
      captured[1].includes(AGENT_OUTPUT_TOOL_NAME),
      'agent_output visible after loading the agent group',
    );
  });

  test('guard rejects same-step load_tools(agent)+agent_spawn before spawning a child', async () => {
    const captured: string[][] = [];
    const spawnCalls: unknown[] = [];
    await drain(
      agentBackend(parallelLoadAgentAndSpawnModel(captured), spawnCalls).send({
        turnId: 'turn-1',
        text: 'load and spawn in one step',
        context: [],
        runId: 'parent-run',
      }),
    );

    assert.ok(
      !captured[0].includes(AGENT_SPAWN_TOOL_NAME),
      'agent_spawn is not advertised at step 0',
    );
    assert.deepEqual(spawnCalls, [], 'agent_spawn must not run before the agent group is active');
  });

  test('deferred agent group is prompt economy only: loaded agent_spawn still uses its permission model', async () => {
    const durable = createDurableTurnHarness({
      turnId: 'turn-1',
      text: 'load then spawn',
      runId: 'parent-run',
    });
    const captured: string[][] = [];
    const spawnCalls: unknown[] = [];
    await drainWithDurableTurn(
      agentBackend(loadAgentThenSpawnModel(captured), spawnCalls, {
        permissionMode: 'execute',
        durable,
      }).send(durable.sendInput({ runId: 'parent-run' })),
      durable,
    );

    assert.ok(
      captured[1].includes(AGENT_SPAWN_TOOL_NAME),
      'agent_spawn is provider-visible only after load',
    );
    assert.equal(
      spawnCalls.length,
      1,
      'execute-mode permission still allows the loaded subagent tool to run',
    );
    assert.partialDeepStrictEqual(spawnCalls[0], {
      parentRunId: 'parent-run',
      parentTurnId: 'turn-1',
      toolCallId: 'tc-spawn',
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'Inspect the runtime tests.',
      abortSignal: assertAbortSignal(spawnCalls[0]),
      onEvent: assertOnEvent(spawnCalls[0]),
    });
  });
});

// ---------------------------------------------------------------------------
// Mock models
// ---------------------------------------------------------------------------

function capturingModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools: stepTools }) => {
      captured.push((stepTools ?? []).map((t) => t.name));
      const parts: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
      ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

function parallelLoadUseModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools: stepTools }) => {
      captured.push((stepTools ?? []).map((t) => t.name));
      const first = captured.length === 1;
      const parts: LanguageModelV4StreamPart[] = first
        ? [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'tc-load',
              toolName: LOAD_TOOLS_NAME,
              input: JSON.stringify({ group: 'browser' }),
            },
            {
              type: 'tool-call',
              toolCallId: 'tc-click',
              toolName: 'browser_click',
              input: JSON.stringify({}),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: ZERO_USAGE,
            },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
          ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

/** Placeholder invalid tool — only used to build providerTools for char math. */
const INVALID_FIXTURE: MakaTool = {
  name: 'invalid',
  description: 'x',
  parameters: z.object({}),
  impl: () => ({}),
};

/** Step 0 loads the browser group, then the turn finishes (no use). */
function loadBrowserThenFinishModel(): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      step += 1;
      const parts: LanguageModelV4StreamPart[] =
        step === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tc-load',
                toolName: LOAD_TOOLS_NAME,
                input: JSON.stringify({ group: 'browser' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: ZERO_USAGE,
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
            ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

/**
 * Step 0 loads the browser group; step 1 emits a mis-cased `BROWSER_CLICK`
 * (a provider that case-drifts a tool that only became active this step). The
 * AI SDK can't match the upper-cased name, so it calls the repair callback.
 */
function loadThenMiscasedClickModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools: stepTools }) => {
      captured.push((stepTools ?? []).map((t) => t.name));
      const step = captured.length;
      const parts: LanguageModelV4StreamPart[] =
        step === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tc-load',
                toolName: LOAD_TOOLS_NAME,
                input: JSON.stringify({ group: 'browser' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: ZERO_USAGE,
              },
            ]
          : step === 2
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'tc-click',
                  toolName: 'BROWSER_CLICK',
                  input: JSON.stringify({}),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: ZERO_USAGE,
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: ZERO_USAGE,
                },
              ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

function loadAgentThenFinishModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools: stepTools }) => {
      captured.push((stepTools ?? []).map((t) => t.name));
      const first = captured.length === 1;
      const parts: LanguageModelV4StreamPart[] = first
        ? [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'tc-load',
              toolName: LOAD_TOOLS_NAME,
              input: JSON.stringify({ group: 'agent' }),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: ZERO_USAGE,
            },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
          ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

function parallelLoadAgentAndSpawnModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools: stepTools }) => {
      captured.push((stepTools ?? []).map((t) => t.name));
      const first = captured.length === 1;
      const parts: LanguageModelV4StreamPart[] = first
        ? [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'tc-load',
              toolName: LOAD_TOOLS_NAME,
              input: JSON.stringify({ group: 'agent' }),
            },
            {
              type: 'tool-call',
              toolCallId: 'tc-spawn',
              toolName: AGENT_SPAWN_TOOL_NAME,
              input: agentSpawnInput(),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: ZERO_USAGE,
            },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
          ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

function loadAgentThenSpawnModel(captured: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ tools: stepTools }) => {
      captured.push((stepTools ?? []).map((t) => t.name));
      const step = captured.length;
      const parts: LanguageModelV4StreamPart[] =
        step === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tc-load',
                toolName: LOAD_TOOLS_NAME,
                input: JSON.stringify({ group: 'agent' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: ZERO_USAGE,
              },
            ]
          : step === 2
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'tc-spawn',
                  toolName: AGENT_SPAWN_TOOL_NAME,
                  input: agentSpawnInput(),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: ZERO_USAGE,
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: ZERO_USAGE,
                },
              ];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

function agentSpawnInput(): string {
  return JSON.stringify({
    profile: LOCAL_READ_AGENT_PROFILE,
    task: 'Inspect the runtime tests.',
  });
}

function assertAbortSignal(value: unknown): AbortSignal {
  assert.ok(
    value &&
      typeof value === 'object' &&
      'abortSignal' in value &&
      value.abortSignal instanceof AbortSignal,
    'spawn input carries an AbortSignal',
  );
  return value.abortSignal;
}

function assertOnEvent(value: unknown): (event: SessionEvent) => void {
  assert.ok(
    value && typeof value === 'object' && 'onEvent' in value && typeof value.onEvent === 'function',
    'spawn input carries a child event observer',
  );
  return value.onEvent as (event: SessionEvent) => void;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A complete prior turn whose model called load_tools(browser) and got a result. */
function priorBrowserLoad(turnId: string): RuntimeEvent[] {
  const base = {
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId,
    ts: 1,
    partial: false,
  } as const;
  return [
    {
      ...base,
      id: 'p-u',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'load browser' },
    },
    {
      ...base,
      id: 'p-call',
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: 'tc-prev',
        name: LOAD_TOOLS_NAME,
        args: { group: 'browser' },
      },
    },
    {
      ...base,
      id: 'p-resp',
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'tc-prev',
        name: LOAD_TOOLS_NAME,
        result: { loaded: ['browser_click'] },
      },
    },
    {
      ...base,
      id: 'p-end',
      role: 'model',
      author: 'agent',
      status: 'completed',
      actions: { endInvocation: true },
    },
  ];
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) {
    void _;
  }
}

function header(permissionMode: SessionHeader['permissionMode'] = 'ask'): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'c',
    connectionLocked: true,
    model: 'm',
    permissionMode,
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'c',
    name: 'OpenAI',
    providerType: 'openai',
    defaultModel: 'mock-model-id',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
