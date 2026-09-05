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
import { resolveHostedWebSearchCapability } from '@maka/core/model-web-search';
import type { HostedWebSearchAdapter } from '@maka/core/model-web-search';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import type { WebSearchSettings } from '@maka/core/web-search';
import type { MakaTool } from './tool-runtime.js';

export const NATIVE_WEB_SEARCH_TOOL_NAME = 'WebSearch';

/**
 * Provider-executed search descriptor. AI SDK compiles this into the selected
 * provider's native tool; the local implementation is an invariant guard only.
 */
export function buildNativeWebSearchTool(input?: {
  readonly adapter?: Extract<HostedWebSearchAdapter, 'openai-responses' | 'anthropic-messages'>;
  readonly searchContextSize?: 'low' | 'medium' | 'high';
  readonly maxUses?: number;
}): MakaTool {
  const adapter = input?.adapter ?? 'openai-responses';
  return {
    name: NATIVE_WEB_SEARCH_TOOL_NAME,
    displayName: 'Web search',
    activityKind: 'websearch',
    categoryHint: 'web_read',
    description:
      'Search and read the live web through the current model provider. Use it for current external information and source-backed answers.',
    parameters: z.object({}).strict(),
    providerTool: {
      ...(adapter === 'anthropic-messages'
        ? {
            kind: 'anthropic-web-search-20250305' as const,
            maxUses: input?.maxUses ?? 8,
          }
        : {
            kind: 'openai-web-search' as const,
            searchContextSize: input?.searchContextSize ?? 'medium',
          }),
    },
    impl: () => {
      throw new Error('Provider-native WebSearch must not execute through ToolRuntime');
    },
  };
}

/** Freezes one unambiguous WebSearch tool meaning for the selected model turn. */
export function routeWebSearchTools(input: {
  readonly tools: readonly MakaTool[];
  readonly settings: Pick<WebSearchSettings, 'enabled' | 'defaultProvider'>;
  readonly connection: RuntimeExecutionConnection;
  readonly model: string;
  /** Canonical call-time readiness for the client-executed Tavily path. */
  readonly tavilyReady: boolean;
  readonly privacy?: { readonly incognitoActive: boolean };
  /** Root surfaces may add native search even when no client WebSearch exists. */
  readonly allowAddNative?: boolean;
}): MakaTool[] {
  const firstSearchIndex = input.tools.findIndex(
    (tool) => tool.name === NATIVE_WEB_SEARCH_TOOL_NAME,
  );
  const withoutWebSearch = input.tools.filter((tool) => tool.name !== NATIVE_WEB_SEARCH_TOOL_NAME);
  if (!input.settings.enabled || input.privacy?.incognitoActive === true) return withoutWebSearch;
  let selected: MakaTool | undefined;
  if (input.settings.defaultProvider === 'tavily') {
    selected = input.tavilyReady
      ? input.tools.find((tool) => tool.name === NATIVE_WEB_SEARCH_TOOL_NAME)
      : undefined;
  } else {
    const capability = resolveHostedWebSearchCapability(
      input.connection.providerType,
      input.connection.models,
      input.model,
    );
    if (
      (firstSearchIndex >= 0 || input.allowAddNative === true) &&
      capability?.implemented === true &&
      capability.adapter === 'openai-responses'
    ) {
      selected = buildNativeWebSearchTool({ adapter: 'openai-responses' });
    } else if (
      (firstSearchIndex >= 0 || input.allowAddNative === true) &&
      capability?.implemented === true &&
      capability.adapter === 'anthropic-messages'
    ) {
      selected = buildNativeWebSearchTool({ adapter: 'anthropic-messages' });
    }
  }
  if (!selected) return withoutWebSearch;
  const insertionIndex =
    firstSearchIndex < 0
      ? withoutWebSearch.length
      : input.tools
          .slice(0, firstSearchIndex)
          .filter((tool) => tool.name !== NATIVE_WEB_SEARCH_TOOL_NAME).length;
  return [
    ...withoutWebSearch.slice(0, insertionIndex),
    selected,
    ...withoutWebSearch.slice(insertionIndex),
  ];
}
