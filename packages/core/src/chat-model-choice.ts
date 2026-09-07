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

import { declaredContextWindow, type ThinkingLevel } from './model-thinking.js';
import {
  offerableCatalogEntries,
  providerDefaultsOf,
  providerMenuLabel,
  type ProjectedLlmConnection,
  type ProviderType,
} from './llm-connections.js';

export interface ChatModelChoice {
  connectionId: string;
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
  /** Exact capability projection used by model-facing attachment composition. */
  supportsVision?: boolean;
  /** Provider/model metadata shown beside the user-declared context setting. */
  contextWindow?: number;
  /** User-declared context target, if this model has one. */
  declaredContextWindow?: number;
}

export function buildChatModelChoices(
  connections: readonly ProjectedLlmConnection[],
): ChatModelChoice[] {
  const choices: ChatModelChoice[] = [];
  for (const connection of connections) {
    const provider = providerDefaultsOf(connection.providerType);
    if (!provider) continue;
    for (const entry of offerableCatalogEntries(connection)) {
      const declaredWindow = declaredContextWindow(connection, entry.id);
      choices.push({
        connectionId: connection.connectionId,
        connectionSlug: connection.slug,
        providerType: connection.providerType,
        providerLabel: providerMenuLabel(connection.providerType) ?? connection.providerType,
        model: entry.id,
        label: entry.displayName?.trim() || entry.id,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        ...(entry.knowledgeCutoff !== undefined ? { knowledgeCutoff: entry.knowledgeCutoff } : {}),
        ...(provider.authKind === 'oauth_token' ? {} : { connectionName: connection.name }),
        isDefault: entry.isDefault,
        thinkingLevels: entry.thinkingLevels,
        supportsVision: entry.supportsVision,
        ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
        ...(declaredWindow !== undefined ? { declaredContextWindow: declaredWindow } : {}),
      });
    }
  }
  return choices;
}
