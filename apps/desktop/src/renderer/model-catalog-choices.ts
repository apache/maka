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
  buildConnectionModelCatalogEntries,
  type ModelCatalogEntry,
} from '@maka/core/model-catalog';
import {
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
} from '@maka/core/llm-connections';
import type { LlmConnection, ProviderType } from '@maka/core/llm-connections';

export function buildCatalogRecommendedDefaultModel(providerType: ProviderType): string {
  const entry = selectableCatalogEntries({
    slug: providerType,
    providerType,
    defaultModel: '',
  })[0];
  return entry?.id ?? '';
}

function selectableCatalogEntries(
  connection: Pick<
    LlmConnection,
    'slug' | 'providerType' | 'defaultModel' | 'models' | 'modelSource' | 'modelsFetchedAt'
  >,
  savedModelIds?: Iterable<string | undefined | null>,
): ModelCatalogEntry[] {
  const entries = filterUnsupportedCodexModels(
    connection.providerType,
    buildConnectionModelCatalogEntries({ connection, savedModelIds }),
  ).filter((entry) => entry.canUseAsChatDefault);
  if (entries.length > 0 || connection.providerType !== 'openai-codex') return entries;
  return filterUnsupportedCodexModels(
    connection.providerType,
    buildConnectionModelCatalogEntries({
      connection: {
        ...connection,
        defaultModel: '',
        models: undefined,
        modelSource: undefined,
        modelsFetchedAt: undefined,
      },
      savedModelIds,
    }),
  ).filter((entry) => entry.canUseAsChatDefault);
}

function filterUnsupportedCodexModels(providerType: ProviderType, entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  if (providerType !== 'openai-codex') return entries;
  return entries.filter((entry) => !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(entry.id.trim()));
}
