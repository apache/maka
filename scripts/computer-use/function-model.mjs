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

import {
  createOpenAIStrictObjectSchema,
  projectOpenAIStrictFunctionArgs,
} from '../../packages/runtime/dist/openai-strict-function.js';
import {
  createSyntheticComputerScenario,
  canonicalizeSyntheticComputerArgs,
  SYNTHETIC_COMPUTER_ALLOWED_KEYS,
  SYNTHETIC_COMPUTER_KNOWN_KEYS,
  SYNTHETIC_COMPUTER_TOOL_PROPERTIES,
} from './synthetic-model-scenario.mjs';

const baseUrl = process.env.MAKA_CU_MODEL_BASE_URL ?? 'http://127.0.0.1:8538/v1';
const model = process.env.MAKA_CU_MODEL_ID ?? 'gpt-5.6-sol';
const maxTurns = 8;
const scenario = createSyntheticComputerScenario();
const { state, calls } = scenario;
let previousResponseId;
let input = [
  {
    role: 'user',
    content: [
      {
        type: 'input_text',
        text:
          'Use maka_computer to set the field labeled "CUA Lab Set Value Field" ' +
          'in the app "Codex CUA Lab" to "model-e2e". Start with list_apps, ' +
          'observe the exact app/window, use set_value with IDs from that observation, ' +
          'verify the fresh observation, then finish.',
      },
    ],
  },
];

const tool = {
  type: 'function',
  name: 'maka_computer',
  description:
    'Accessibility-first desktop control. Start with list_apps or observe. ' +
    'Use set_value or click_element with IDs from the latest observation. ' +
    'Coordinate click, scroll, drag, press_key, type, and pixel fallback are disabled.',
  parameters: createOpenAIStrictObjectSchema({
    properties: SYNTHETIC_COMPUTER_TOOL_PROPERTIES,
  }),
  strict: true,
};

for (let turn = 1; turn <= maxTurns; turn += 1) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions:
        'Operate only the synthetic fixture through maka_computer. Treat tool output as ' +
        'authoritative. Never invent observation or element IDs. Never use coordinate input.',
      tools: [tool],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      input,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      store: false,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`model request failed ${response.status}: ${bounded(body)}`);
  }
  const decoded = JSON.parse(body);
  previousResponseId = decoded.id;
  const toolCalls = decoded.output?.filter((item) => item.type === 'function_call') ?? [];
  if (toolCalls.length === 0) {
    const text =
      decoded.output
        ?.flatMap((item) => item.content ?? [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text)
        .join('') ?? '';
    if (state.value !== 'model-e2e') {
      throw new Error(`model finished before verified mutation: ${bounded(text)}`);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          model,
          turns: turn,
          calls,
          finalValue: state.value,
          finalTextPresent: text.trim().length > 0,
          finalTextChars: text.length,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(0);
  }
  if (toolCalls.length !== 1) {
    throw new Error(`expected one serial tool call, got ${toolCalls.length}`);
  }
  const call = toolCalls[0];
  if (call.name !== 'maka_computer') {
    throw new Error(`unexpected tool ${call.name}`);
  }
  const { args, discardedKeys } = normalizeArgs(JSON.parse(call.arguments));
  const result = scenario.execute(canonicalizeSyntheticComputerArgs(args), discardedKeys);
  input = [
    {
      type: 'function_call_output',
      call_id: call.call_id,
      output: JSON.stringify(result),
    },
  ];
}

throw new Error(`model loop exceeded ${maxTurns} turns`);

function normalizeArgs(value) {
  return projectOpenAIStrictFunctionArgs({
    value,
    knownKeys: SYNTHETIC_COMPUTER_KNOWN_KEYS,
    allowedKeysByAction: SYNTHETIC_COMPUTER_ALLOWED_KEYS,
  });
}

function bounded(value) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length <= 300 ? text : `${text.slice(0, 300)}...[truncated]`;
}
