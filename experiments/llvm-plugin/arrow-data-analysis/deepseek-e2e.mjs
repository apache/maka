#!/usr/bin/env node
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

import { invokeArrowTool, withArrowTool } from './e2e.mjs';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.log('SKIP: DEEPSEEK_API_KEY is not set; local Arrow E2E remains runnable.');
} else {
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  await withArrowTool(async (tool) => {
    const messages = [
      {
        role: 'system',
        content:
          'Use arrow_analyze for numeric data analysis. Prefer group_sum when a grouping column is provided.',
      },
      {
        role: 'user',
        content:
          'Analyze revenue by region for this dataset: revenue=[120,80,null,200], region=[east,west,east,west]. Call the tool, then explain the result briefly.',
      },
    ];
    const toolDefinition = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
    const first = await chat(baseUrl, apiKey, {
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      temperature: 0,
      messages,
      tools: [toolDefinition],
      tool_choice: { type: 'function', function: { name: tool.name } },
    });
    const assistant = first.choices?.[0]?.message;
    const call = assistant?.tool_calls?.[0];
    if (!call?.function?.arguments) {
      throw new Error('DeepSeek did not return an arrow_analyze tool call');
    }
    const argumentsValue = JSON.parse(call.function.arguments);
    const toolResult = await invokeArrowTool(tool, argumentsValue);
    const second = await chat(baseUrl, apiKey, {
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      temperature: 0,
      messages: [
        ...messages,
        assistant,
        {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(toolResult),
        },
      ],
      tools: [toolDefinition],
    });
    console.log(
      JSON.stringify(
        {
          toolArguments: argumentsValue,
          arrowResult: toolResult,
          deepseekSummary: second.choices?.[0]?.message?.content ?? null,
        },
        null,
        2,
      ),
    );
  });
}

async function chat(baseUrl, key, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`DeepSeek API returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}
