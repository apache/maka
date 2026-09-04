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
import test from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import { buildAgentSwarmStatusTool } from '@maka/runtime/agent-swarm-status-tool';
import { buildComputerUseTools } from '@maka/runtime/computer-use-tools';
import { buildDeepResearchTools } from '@maka/runtime/deep-research-tools';
import { buildGoalTools } from '@maka/runtime/goal-tools';
import { buildHistoryTools } from '@maka/runtime/history-tools';
import { buildMemoryExtractionTriggerTools } from '@maka/runtime/memory-extraction';
import {
  buildCancelPlanTool,
  buildSubmitPlanTool,
  buildUpdatePlanTool,
} from '@maka/runtime/plan-tools';
import { buildScheduledTaskTool } from '@maka/runtime/scheduled-task-tools';
import { buildParentAgentTools } from '@maka/runtime/subagent-tools';
import { buildAgentGraphSupervisorTools } from '@maka/runtime/test-only/tool-presentation';
import { createToolResultArchiveCapability } from '@maka/runtime/tool-result-archive-capability';
import {
  buildHostAgentSettingsTools,
  createInteractiveRunComposer,
  createHostWebFetchTool,
  createHostWebSearchTool,
} from '@maka/runtime-host/test-only/interactive-run-composer';
import { BUILTIN_TOOL_LABELS } from '@maka/ui';
import { buildBrowserTools } from '../browser/browser-tools.js';
import { buildClientSettingsTools } from '../client-settings-tools.js';
import { buildRiveWorkflowTool } from '../rive-workflow-tool.js';

function assertLocalized(tools: readonly { readonly name: string }[]): void {
  assert.deepEqual(
    tools.map(({ name }) => name).filter((name) => !Object.hasOwn(BUILTIN_TOOL_LABELS, name)),
    [],
  );
}

test('every default Runtime Host tool has localized Desktop presentation', () => {
  const composer = createInteractiveRunComposer({
    runtimePolicy: { revision: 0, policy: createDefaultRuntimePolicy() },
    skills: {
      readCanonicalModelInventory: async () => ({ inventory: [] }),
    } as never,
    memory: {} as never,
    sessionTodo: {} as never,
    builtinTools: {
      backgroundTasks: {} as never,
      ptyControls: {} as never,
    },
  });

  assertLocalized(composer.tools);
});

test('every conditional Runtime Host tool has localized Desktop presentation', () => {
  assertLocalized([
    ...buildHostAgentSettingsTools({} as never),
    createHostWebSearchTool({} as never),
    createHostWebFetchTool({} as never),
    ...buildHistoryTools({} as never),
    buildScheduledTaskTool({} as never),
    ...buildGoalTools({} as never),
    ...buildParentAgentTools(),
    buildSubmitPlanTool({} as never),
    buildUpdatePlanTool({} as never, 'presentation-contract'),
    buildCancelPlanTool({} as never, 'presentation-contract'),
    ...buildDeepResearchTools({} as never),
    ...buildAgentGraphSupervisorTools({ graphId: 'presentation-contract' } as never),
    buildAgentSwarmStatusTool({} as never),
    ...buildMemoryExtractionTriggerTools({} as never),
    createToolResultArchiveCapability({} as never).archiveReadTool,
  ]);
});

test('every Desktop-owned tool has localized presentation', () => {
  const tools = [
    ...buildBrowserTools(),
    ...buildComputerUseTools({ backend: {} as never }),
    ...buildClientSettingsTools({} as never),
    buildRiveWorkflowTool(),
  ];

  assertLocalized(tools);
});
