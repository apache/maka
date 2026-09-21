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
import { test } from 'node:test';
import {
  emptyPlanSessionState,
  type PlanExecution,
  type PlanExecutionStep,
  type PlanSessionState,
  type PlanStore,
} from '@maka/core/plan';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { SessionTodoToolStore } from '@maka/runtime/session-todo-tools';
import { z } from 'zod';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { createInteractiveRunComposer } from '../server/interactive-run-composer.js';
import type { HostMemoryCoordinator } from '../server/memory-coordinator.js';
import type { HostSkillCatalogCoordinator } from '../server/skill-catalog-coordinator.js';
import { WORKHUB_BROWSER_TOOL_NAMES } from './fixtures/workhub-capabilities.js';

test('the interactive tool surface does not expose retired tools', () => {
  const composer = createFixtureComposer();

  assert.equal(
    composer.tools.some(({ name }) => name === 'ExploreAgent' || name.startsWith('deep_research_')),
    false,
  );
});

test('the composer resolves scoped Tool additions without rebuilding the backend', () => {
  let additions: readonly MakaTool[] = [];
  const dynamic = tool('dynamic_tool');
  const composer = createFixtureComposer({ resolveAdditionalTools: () => additions });

  assert.equal(
    composer.tools.some(({ name }) => name === dynamic.name),
    false,
  );
  additions = [dynamic];
  assert.equal(
    composer.resolveTools?.().some(({ name }) => name === dynamic.name),
    true,
  );
});

test('the composer keeps Host bindings stable while resampling scoped Tool additions', () => {
  let additions: readonly MakaTool[] = [];
  const composer = createFixtureComposer({ resolveAdditionalTools: () => additions });
  const initialRead = composer.tools.find(({ name }) => name === 'Read');
  assert.ok(initialRead);

  additions = [tool('dynamic_tool')];
  const next = composer.resolveTools?.() ?? [];
  assert.equal(
    next.find(({ name }) => name === 'Read'),
    initialRead,
  );
  assert.equal(
    next.some(({ name }) => name === 'dynamic_tool'),
    true,
  );
});

test('scoped Tool resolution receives the complete stable Host binding', () => {
  let observedHostTools: readonly MakaTool[] = [];
  const composer = createFixtureComposer({
    hostTools: [tool('host_extension')],
    resolveAdditionalTools: (hostTools) => {
      observedHostTools = hostTools;
      return [tool('plugin_extension')];
    },
  });

  assert.equal(
    observedHostTools.some(({ name }) => name === 'Read'),
    true,
  );
  assert.equal(
    observedHostTools.some(({ name }) => name === 'host_extension'),
    true,
  );
  assert.equal(
    composer.tools.some(({ name }) => name === 'plugin_extension'),
    true,
  );
});

test('Full access composes Bash without a boundary declaration and without the widening tool', () => {
  const bashKeys = (permissionMode: 'bypass' | 'ask' | undefined) => {
    const composer = createFixtureComposer({
      builtinTools: unusedManagedShellBuiltinTools(),
      ...(permissionMode
        ? {
            plan: {
              store: {} as PlanStore,
              state: emptyPlanSessionState('session'),
              mode: 'agent' as const,
              permissionMode,
            },
          }
        : {}),
    });
    const tools = composer.resolveTools?.() ?? [];
    const bash = tools.find(({ name }) => name === 'Bash');
    assert.ok(bash);
    return {
      keys: Object.keys(z.toJSONSchema(bash.parameters as z.ZodTypeAny).properties ?? {}),
      widening: tools.some(({ name }) => name === 'request_sandbox_boundary'),
      enforced: bash.description.includes('Enforced by the current session sandbox boundary.'),
    };
  };
  assert.deepEqual(bashKeys('bypass'), {
    keys: ['command', 'timeout_ms', 'run_in_background', 'pty'],
    widening: false,
    enforced: false,
  });
  for (const mode of ['ask', undefined] as const) {
    assert.deepEqual(bashKeys(mode), {
      keys: [
        'command',
        'timeout_ms',
        'run_in_background',
        'pty',
        'boundary_intent',
        'required_boundary',
      ],
      widening: true,
      enforced: true,
    });
  }
});

test('an explicit tool profile remains an exact ceiling over scoped Tool additions', () => {
  const composer = createFixtureComposer({
    builtinTools: unusedManagedShellBuiltinTools(),
    toolProfile: 'headless-coding-v1',
    resolveAdditionalTools: () => [tool('Read'), tool('plugin_only')],
  });

  assert.equal(
    composer.resolveTools?.().some(({ name }) => name === 'plugin_only'),
    false,
  );
  assert.equal(composer.resolveTools?.().filter(({ name }) => name === 'Read').length, 1);
});

test('the composer caches the Host base but reassembles scoped Plugin prompts each step', async () => {
  let pluginText = 'FIRST_PLUGIN_PROMPT';
  let assemblies = 0;
  const composer = createFixtureComposer({
    resolveAdditionalSystemPrompt: async (_context, baseText) => {
      assemblies += 1;
      return {
        text: `${baseText}\n\n${pluginText}`,
        sourceRevisions: [{ id: 'plugin.system-prompt', revision: `revision-${assemblies}` }],
      };
    },
  });
  const context = { sessionId: 'session', turnId: 'turn', cwd: '/workspace' };

  const first = await composer.resolveSystemPrompt(context);
  pluginText = 'SECOND_PLUGIN_PROMPT';
  const second = await composer.resolveSystemPrompt(context);

  assert.match(first.text ?? '', /FIRST_PLUGIN_PROMPT/u);
  assert.match(second.text ?? '', /SECOND_PLUGIN_PROMPT/u);
  assert.equal(assemblies, 2);
  assert.deepEqual(
    second.sourceRevisions.find(({ id }) => id === 'plugin.system-prompt'),
    { id: 'plugin.system-prompt', revision: 'revision-2' },
  );
});

test('the composer preserves scoped dynamic contexts for each model step', async () => {
  const contexts = [{ name: 'plugin:context', text: 'EPHEMERAL_CONTEXT' }];
  const composer = createFixtureComposer({
    resolveAdditionalSystemPrompt: async (_context, baseText) => ({
      text: baseText,
      contexts,
      sourceRevisions: [],
    }),
  });

  const prompt = await composer.resolveSystemPrompt({
    sessionId: 'session',
    turnId: 'turn',
    cwd: '/workspace',
  });

  assert.deepEqual(prompt.contexts, contexts);
});

test('scoped Plugin Skill contributions join the canonical model inventory', async () => {
  const composer = createFixtureComposer({
    skills: {
      readCanonicalModelInventory: async ({ projectRoot }: { projectRoot: string }) => ({
        revision: 'base-revision',
        projectRoot,
        inventory: [],
        diagnostics: [],
        discoveryDiagnostics: [],
      }),
    } as unknown as HostSkillCatalogCoordinator,
    pluginSkills: {
      snapshot: (sessionId: string) => ({
        revision: 4,
        skills: [
          {
            name: 'plugin-probe',
            description: `Scoped skill for ${sessionId}`,
            instructions: 'PLUGIN_SKILL_INSTRUCTIONS',
          },
        ],
      }),
    } as never,
  });

  const prompt = await composer.resolveSystemPrompt({
    sessionId: 'session-skill',
    turnId: 'turn-skill',
    cwd: '/workspace',
  });
  assert.match(prompt.text ?? '', /plugin-probe/u);
  assert.match(prompt.text ?? '', /Scoped skill for session-skill/u);
});

function tool(name: string): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    impl: async () => name,
  };
}
test('WorkHub v2 binds control, tasks, attachment reading and user questions while legacy WorkHub stays tool-free', () => {
  const control = tool('mcp__desktop_workhub__control');
  const tasks = tool('mcp__desktop_workhub__tasks');
  const browserTools = WORKHUB_BROWSER_TOOL_NAMES.map((name) =>
    tool(`mcp__desktop_browser__${name}`),
  );
  const clientCapabilities = {
    tools: [control, tasks, ...browserTools, tool('Bash')],
    groups: [],
  };
  assert.deepEqual(
    createFixtureComposer({
      toolProfile: 'workhub-coordination-v2',
      clientCapabilities,
      resolveAdditionalTools: () => [tool('plugin_only'), tool('Read')],
    }).tools.map(({ name }) => name),
    [control.name, tasks.name, ...browserTools.map(({ name }) => name), 'Read', 'AskUserQuestion'],
  );
  assert.deepEqual(
    createFixtureComposer({
      toolProfile: 'workhub-coordination-v1',
      clientCapabilities,
    }).tools,
    [],
  );
  assert.throws(
    () =>
      createFixtureComposer({
        toolProfile: 'workhub-coordination-v2',
        clientCapabilities: { tools: [control], groups: [] },
      }),
    /Hosted tool profile is unavailable: mcp__desktop_workhub__tasks/,
  );
  assert.throws(
    () =>
      createFixtureComposer({
        toolProfile: 'workhub-coordination-v2',
        boundTools: [],
        clientCapabilities,
      }),
    /Hosted tool profile is unavailable/,
  );
});

test('Plan execution tools are bound only for active agent executions', () => {
  const activeAgentTools = createFixtureComposer({
    plan: {
      store: {} as PlanStore,
      state: activePlanState(),
      mode: 'agent',
    },
  }).tools.map(({ name }) => name);
  assert.equal(activeAgentTools.includes('update_plan'), true);
  assert.equal(activeAgentTools.includes('cancel_plan'), true);
  assert.equal(activeAgentTools.includes('SubmitPlan'), false);

  const idleAgentTools = createFixtureComposer({
    plan: {
      store: {} as PlanStore,
      state: emptyPlanSessionState('session-1'),
      mode: 'agent',
    },
  }).tools.map(({ name }) => name);
  assert.equal(idleAgentTools.includes('update_plan'), false);
  assert.equal(idleAgentTools.includes('cancel_plan'), false);
  assert.equal(idleAgentTools.includes('SubmitPlan'), false);

  const planModeTools = createFixtureComposer({
    plan: {
      store: {} as PlanStore,
      state: emptyPlanSessionState('session-1'),
      mode: 'plan',
    },
  }).tools.map(({ name }) => name);
  assert.equal(planModeTools.includes('SubmitPlan'), true);
  assert.equal(planModeTools.includes('update_plan'), false);
  assert.equal(planModeTools.includes('cancel_plan'), false);
});

function planStep(status: PlanExecutionStep['status']): PlanExecutionStep {
  return {
    id: 'step-1',
    title: 'Step one',
    description: 'Do the first step.',
    status,
    updatedAt: 2,
  };
}

function activePlanState(
  overrides: {
    storeVersion?: number;
    status?: PlanExecution['status'];
    step?: PlanExecutionStep;
  } = {},
): PlanSessionState {
  const step = overrides.step ?? planStep('pending');
  const status = overrides.status ?? 'active';
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    storeVersion: overrides.storeVersion ?? 2,
    proposals: [
      {
        planId: 'plan-1',
        proposalId: 'proposal-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        revision: 1,
        title: 'Ship the plan request',
        steps: [{ id: step.id, title: step.title, description: step.description }],
        status: 'approved',
        submittedAt: 1,
      },
    ],
    executions: [
      {
        executionId: 'execution-1',
        planId: 'plan-1',
        proposalId: 'proposal-1',
        sessionId: 'session-1',
        status,
        steps: [step],
        startedAt: 1,
        updatedAt: 2,
      },
    ],
    latestProposalId: 'proposal-1',
    // Only an active execution is the Session's current one; a cancelled or
    // completed execution must not stay selected.
    ...(status === 'active' ? { activeExecutionId: 'execution-1' } : {}),
  };
}

function unusedManagedShellBuiltinTools(): Parameters<
  typeof createInteractiveRunComposer
>[0]['builtinTools'] {
  const unused = () => Promise.reject(new Error('not used'));
  return {
    shellRuns: { runForegroundBash: unused, runBackgroundBash: unused },
    backgroundTasks: { stopBackgroundTask: unused },
    ptyControls: { writeStdin: unused },
  };
}

function createFixtureComposer(
  overrides: Partial<Parameters<typeof createInteractiveRunComposer>[0]> = {},
) {
  return createInteractiveRunComposer({
    runtimePolicy: { revision: 0, policy: createDefaultRuntimePolicy() },
    skills: {
      readCanonicalModelInventory: async () => ({ inventory: [] }),
    } as unknown as HostSkillCatalogCoordinator,
    memory: {
      readPromptProjection: async () => ({
        bundleRevision: null,
        memoryRevision: null,
        body: undefined,
      }),
    } as unknown as HostMemoryCoordinator,
    sessionTodo: {} as SessionTodoToolStore,
    builtinTools: {},
    ...overrides,
  });
}
