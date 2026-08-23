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

import { normalizeOpenAiCodexConnection } from './connection-readiness.js';
import { buildConnectionModelCatalogEntries } from './model-catalog.js';
import { thinkingVariantsForConnection, type ThinkingLevel } from './model-thinking.js';
import {
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  connectionEnabledModelIds,
  providerDefaultsOf,
  type LlmConnection,
  type ProviderType,
} from './llm-connections.js';

const MODEL_MENU_PROVIDER_LABELS: Partial<Record<ProviderType, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot',
  ollama: 'Ollama',
  'kimi-coding-plan': 'Kimi',
  'zai-coding-plan': 'Z.AI',
  MiniMax: 'MiniMax',
  'openai-codex': 'OpenAI OAuth',
};

export interface ChatModelChoice {
  connectionSlug: string;
  providerType: ProviderType;
  providerLabel: string;
  model: string;
  label: string;
  description?: string;
  knowledgeCutoff?: string;
  connectionName?: string;
  isDefault: boolean;
  thinkingLevels: readonly ThinkingLevel[];
}

export function buildChatModelChoices(connections: readonly LlmConnection[]): ChatModelChoice[] {
  const choices: ChatModelChoice[] = [];
  for (const rawConnection of connections) {
    const connection = normalizeOpenAiCodexConnection(rawConnection);
    const provider = providerDefaultsOf(connection.providerType);
    if (!connection.enabled || !provider) {
      continue;
    }
    const enabledModelIds = new Set(connectionEnabledModelIds(connection));
    for (const entry of buildConnectionModelCatalogEntries({ connection })) {
      if (
        !entry.canUseAsChatDefault ||
        !enabledModelIds.has(entry.id) ||
        (connection.providerType === 'openai-codex' &&
          CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(entry.id.trim()))
      ) {
        continue;
      }
      choices.push({
        connectionSlug: connection.slug,
        providerType: connection.providerType,
        providerLabel: MODEL_MENU_PROVIDER_LABELS[connection.providerType] ?? provider.label,
        model: entry.id,
        label: entry.displayName?.trim() || entry.id,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        ...(entry.knowledgeCutoff !== undefined ? { knowledgeCutoff: entry.knowledgeCutoff } : {}),
        ...(provider.authKind === 'oauth_token' ? {} : { connectionName: connection.name }),
        isDefault: entry.isDefault,
        thinkingLevels: thinkingVariantsForConnection(connection, entry.id),
      });
    }
  }
  return choices;
}
