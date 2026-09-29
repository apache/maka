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

import type {
  Experimental_OpenResponsesBareExtension,
  Experimental_OpenResponsesExtensionItem,
} from '@ai-sdk/open-responses';
import type { RuntimeEventReplayToolCallItem } from './model-history.js';

const EXTENSION_ID = 'deepseek.web_search';
const MAX_ITEM_JSON_CHARS = 128 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function completedWebSearchItem(
  value: unknown,
): value is Experimental_OpenResponsesExtensionItem<string> {
  if (!isRecord(value) || value.type !== 'web_search_call' || value.status !== 'completed') {
    return false;
  }
  if (typeof value.id !== 'string' || !value.id || !isRecord(value.action)) return false;
  try {
    return JSON.stringify(value).length <= MAX_ITEM_JSON_CHARS;
  } catch {
    return false;
  }
}

/** Only original, completed provider output is eligible for exact replay. */
export function deepSeekWebSearchReplayItem(
  call: RuntimeEventReplayToolCallItem,
): Experimental_OpenResponsesExtensionItem<string> | undefined {
  if (call.providerExecuted !== true || call.toolName !== 'WebSearch') return undefined;
  const deepseek = call.providerOptions?.deepseek;
  const item = isRecord(deepseek) ? deepseek.makaWebSearchItem : undefined;
  return completedWebSearchItem(item) && item.id === call.toolCallId ? item : undefined;
}

export function deepSeekWebSearchReplayOptions(
  item: Experimental_OpenResponsesExtensionItem<string>,
) {
  return { deepseek: { openResponsesExtension: { id: EXTENSION_ID, item } } };
}

/**
 * Decode old DeepSeek Responses web search output. Current DeepSeek models
 * ignore built-in web_search; Maka does not route any tool to this encoder.
 */
export const deepSeekWebSearchCodec: Experimental_OpenResponsesBareExtension = {
  id: EXTENSION_ID,
  allowBareTypes: true,
  bareToolType: 'web_search',
  encodeTool: () => ({}),
  bareItemTypes: ['web_search_call'],
  decodeItem: ({ item }) => {
    if (!completedWebSearchItem(item)) return undefined;
    return [
      {
        type: 'tool-call',
        toolCallId: item.id,
        toolName: 'WebSearch',
        input: JSON.stringify(item.action),
        providerExecuted: true,
        providerMetadata: { deepseek: { makaWebSearchItem: item } },
      },
      {
        type: 'tool-result',
        toolCallId: item.id,
        toolName: 'WebSearch',
        result: {
          action: item.action ?? null,
          sources: item.sources ?? (isRecord(item.action) ? item.action.sources : undefined) ?? [],
        },
      },
    ];
  },
};
