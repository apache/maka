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

import { AiSdkBackend } from '../../packages/runtime/dist/ai-sdk-backend.js';
import { buildComputerUseTools } from '../../packages/runtime/dist/computer-use-tools.js';
import { getAIModel } from '../../packages/runtime/dist/model-factory.js';
import {
  createSyntheticComputerScenario,
  canonicalizeSyntheticComputerArgs,
} from './synthetic-model-scenario.mjs';
import { createDirectRuntimeTurnLedger } from './direct-runtime-ledger.mjs';

const baseUrl = process.env.MAKA_CU_MODEL_BASE_URL ?? 'http://127.0.0.1:8538/v1';
const modelId = process.env.MAKA_CU_MODEL_ID ?? 'gpt-5.6-sol';
const scenario = createSyntheticComputerScenario();
const backend = {
  async preflight() {
    return { accessibility: true, screenRecording: true };
  },
  async listApps() {
    const result = scenario.execute({ action: 'list_apps' });
    return result.apps.map((app) => ({
      appId: app.app_id,
      pid: app.pid,
      name: app.name,
      windowCount: app.windows.length,
      windows: app.windows.map((window) => ({
        windowId: window.window_id,
        title: window.title,
      })),
    }));
  },
  async observeApp(input) {
    const result = scenario.execute(
      canonicalizeSyntheticComputerArgs({
        action: 'observe',
        app: input.app,
        window_id: input.windowId,
      }),
    );
    return toRuntimeObservation(result);
  },
  async runSemantic(action) {
    if (action.type !== 'set_value') {
      return {
        outcome: {
          ok: false,
          error: 'unsupported_action',
          message: `synthetic runtime E2E rejects ${action.type}`,
        },
      };
    }
    const result = scenario.execute({
      action: 'set_value',
      observation_id: action.observationId,
      element_id: action.elementId,
      value: action.value,
    });
    return {
      outcome: result.outcome,
      observation: toRuntimeObservation(result.fresh_observation),
    };
  },
  async captureObservation(input) {
    return toRuntimeObservation(
      scenario.execute({
        action: 'observe',
        app: input.app,
        window_id: input.windowId,
        include_screenshot: true,
      }),
    );
  },
  async run(action) {
    return {
      outcome: {
        ok: false,
        error: 'unsupported_action',
        message:
          `background '${action.type}' is disabled because the compatibility ` +
          'event backend can interfere with physical user input',
      },
    };
  },
};
const [computerTool] = buildComputerUseTools({ backend });
const messages = [];
const telemetry = [];
const connection = {
  slug: 'azure-bridge',
  name: 'Azure Bridge',
  providerType: 'openai',
  baseUrl,
  defaultModel: modelId,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};
let nextId = 0;
let now = Date.now();
const turnId = 'turn-real-model';
const turnText =
  'Use Maka Computer to set "CUA Lab Set Value Field" in "Codex CUA Lab" ' +
  'to "model-e2e". Start with list_apps, observe the exact app/window, ' +
  'use set_value with IDs from the observation, verify the fresh observation, ' +
  'and then finish.';
const durableTurn = createDirectRuntimeTurnLedger({
  sessionId: 'real-runtime-model-e2e',
  turnId,
  text: turnText,
  newId: () => `runtime-event-${++nextId}`,
  now: () => ++now,
});
const runtime = new AiSdkBackend({
  sessionId: 'real-runtime-model-e2e',
  header: {
    id: 'real-runtime-model-e2e',
    workspaceRoot: process.cwd(),
    cwd: process.cwd(),
    createdAt: now,
    lastUsedAt: now,
    name: 'Real Runtime Computer Use E2E',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: now,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: connection.slug,
    connectionLocked: true,
    model: modelId,
    permissionMode: 'bypass',
    schemaVersion: 1,
  },
  appendMessage: async (message) => {
    messages.push(message);
  },
  connection,
  apiKey: 'bridge-managed',
  modelId,
  readExecutionBoundary: async () => ({ kind: 'bypass', revision: 0 }),
  modelFactory: (input) => getAIModel(input),
  tools: [computerTool],
  maxSteps: 8,
  loadTurnRuntimeEvents: durableTurn.loadTurnRuntimeEvents,
  newId: () => `id-${++nextId}`,
  now: () => ++now,
  recordToolInvocation: (record) => {
    telemetry.push({
      toolName: record.toolName,
      status: record.status,
      argsSummary: record.argsSummary,
    });
  },
});

const events = [];
for await (const event of runtime.send({
  turnId,
  text: turnText,
  context: [],
  headAnchorRuntimeEvent: durableTurn.anchor,
})) {
  durableTurn.record(event);
  events.push(event.type);
}

if (scenario.state.value !== 'model-e2e') {
  throw new Error(
    `real Runtime model loop did not mutate the semantic fixture: ${scenario.state.value}`,
  );
}
if (events.at(-1) !== 'complete') {
  throw new Error(`real Runtime model loop did not complete: ${events.at(-1)}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      provider: 'openai-responses-via-azure-bridge',
      model: modelId,
      events,
      calls: scenario.calls,
      telemetry,
      persistedTypes: messages.map((message) => message.type),
      finalValue: scenario.state.value,
    },
    null,
    2,
  )}\n`,
);

function toRuntimeObservation(input) {
  return {
    observationId: input.observation_id,
    appId: input.app,
    pid: input.pid,
    windowId: input.window_id,
    windowTitle: 'Codex CUA Lab',
    contentFingerprint: 'synthetic-runtime-model-e2e',
    elements: input.elements.map((element) => ({
      elementId: element.element_id,
      role: element.role,
      label: element.label,
      value: element.value,
      identity: {
        role: element.role,
        label: element.label,
        value: element.value,
      },
    })),
    screenshot: {
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      widthPx: 1,
      heightPx: 1,
    },
  };
}
