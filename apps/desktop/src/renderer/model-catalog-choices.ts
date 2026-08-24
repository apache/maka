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
  type SavedModelChoice,
} from '@maka/core/model-catalog';
import {
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  PROVIDER_DEFAULTS,
  connectionEnabledModelIds,
  providerDefaultsOf,
} from '@maka/core/llm-connections';
import type { LlmConnection, ProviderType } from '@maka/core/llm-connections';
import type { UiLocale } from '@maka/core/ui-locale';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';

const DAILY_REVIEW_MODEL_KEY_SEPARATOR = '::';

export function buildCatalogRecommendedDefaultModel(providerType: ProviderType): string {
  const entry = selectableCatalogEntries({
    slug: providerType,
    providerType,
    defaultModel: '',
  })[0];
  return entry?.id ?? '';
}

export function buildCatalogDailyReviewModelOptions(
  connections: readonly LlmConnection[],
  currentModelKey: string,
  locale: UiLocale = 'zh',
): Array<readonly [string, string]> {
  const current = parseDailyReviewModelKey(currentModelKey);
  const candidates: Array<{ key: string; label: string; safeSourceLabel: string }> = [];
  const seenKeys = new Set<string>();
  const providerCounts = enabledProviderCounts(connections);

  for (const connection of connections) {
    if (!isModelConsumerConnection(connection)) continue;
    const savedModelIds: SavedModelChoice[] = current?.connectionSlug === connection.slug
      ? [{ id: current.model, source: 'daily_review_model' }]
      : [];
    const safeSourceLabel = safeConnectionLabel(connection.providerType, connection.slug, providerCounts);
    for (const entry of dailyReviewCatalogEntries(connection, savedModelIds)) {
      const key = dailyReviewModelKey(connection.slug, entry.id);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      candidates.push({ key, label: dailyReviewModelDisplayLabel(entry, locale), safeSourceLabel });
    }
  }

  const options: Array<readonly [string, string]> = [];
  const modelCounts = new Map<string, number>();
  for (const candidate of candidates) {
    modelCounts.set(candidate.label, (modelCounts.get(candidate.label) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    const label = (modelCounts.get(candidate.label) ?? 0) > 1
      ? `${candidate.label} · ${candidate.safeSourceLabel}`
      : candidate.label;
    options.push([candidate.key, label]);
  }

  const trimmedCurrent = currentModelKey.trim();
  if (trimmedCurrent && !options.some(([value]) => value === trimmedCurrent)) {
    const label = current?.model || trimmedCurrent.split(DAILY_REVIEW_MODEL_KEY_SEPARATOR).pop() || trimmedCurrent;
    const sourceLabel = current?.connectionSlug ? ` · ${current.connectionSlug}` : '';
    options.push([trimmedCurrent, `${label}${sourceLabel} · ${getShellRemainingCopy(locale).models.unavailable}`]);
  }

  return options;
}

function dailyReviewCatalogEntries(
  connection: Pick<
    LlmConnection,
    'slug' | 'providerType' | 'defaultModel' | 'enabledModelIds' | 'models' | 'modelSource' | 'modelsFetchedAt'
  >,
  savedModelIds: Iterable<SavedModelChoice | undefined | null>,
): ModelCatalogEntry[] {
  const savedChoices = Array.from(savedModelIds);
  const enabledIds = new Set(connectionEnabledModelIds(connection));
  const visibleIds = new Set(enabledIds);
  for (const choice of savedChoices) {
    const id = typeof choice === 'string' ? choice.trim() : choice?.id.trim();
    if (id) visibleIds.add(id);
  }
  return filterUnsupportedCodexModels(
    connection.providerType,
    buildConnectionModelCatalogEntries({ connection, savedModelIds: savedChoices }),
  )
    .filter((entry) => visibleIds.has(entry.id) && (
      entry.canUseAsChatDefault || entry.provenance.sources?.userChoice?.includes('daily_review_model')
    ))
    .map((entry) => enabledIds.has(entry.id) ? entry : { ...entry, canUseAsChatDefault: false });
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

function modelDisplayLabel(entry: Pick<ModelCatalogEntry, 'id' | 'displayName'>): string {
  return entry.displayName?.trim() || entry.id;
}

function dailyReviewModelDisplayLabel(
  entry: Pick<ModelCatalogEntry, 'id' | 'displayName' | 'canUseAsChatDefault'>,
  locale: UiLocale = 'zh',
): string {
  const label = modelDisplayLabel(entry);
  return entry.canUseAsChatDefault ? label : `${label} · ${getShellRemainingCopy(locale).models.unavailable}`;
}

function isModelConsumerConnection(connection: Pick<LlmConnection, 'enabled' | 'providerType'>): boolean {
  // Unknown providerType (legacy seed, or a connection persisted on a branch
  // that registers a provider this build doesn't know) → not a model consumer.
  // Mirrors `isRealConnection` in connection-readiness.ts.
  return connection.enabled && providerDefaultsOf(connection.providerType) !== undefined;
}

function enabledProviderCounts(connections: readonly LlmConnection[]): Map<ProviderType, number> {
  const counts = new Map<ProviderType, number>();
  for (const connection of connections) {
    if (!isModelConsumerConnection(connection)) continue;
    counts.set(connection.providerType, (counts.get(connection.providerType) ?? 0) + 1);
  }
  return counts;
}

function safeConnectionLabel(
  providerType: ProviderType,
  connectionSlug: string,
  providerCounts: ReadonlyMap<ProviderType, number>,
): string {
  const label = PROVIDER_DEFAULTS[providerType].label;
  return (providerCounts.get(providerType) ?? 0) > 1 ? `${label} · ${connectionSlug}` : label;
}

function dailyReviewModelKey(connectionSlug: string, model: string): string {
  return `${connectionSlug}${DAILY_REVIEW_MODEL_KEY_SEPARATOR}${model}`;
}

function parseDailyReviewModelKey(value: string): { connectionSlug: string; model: string } | undefined {
  const trimmed = value.trim();
  const index = trimmed.indexOf(DAILY_REVIEW_MODEL_KEY_SEPARATOR);
  if (index <= 0) return undefined;
  const connectionSlug = trimmed.slice(0, index);
  const model = trimmed.slice(index + DAILY_REVIEW_MODEL_KEY_SEPARATOR.length);
  if (!connectionSlug || !model) return undefined;
  return { connectionSlug, model };
}
