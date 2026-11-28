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

import type { SettingsProviderSummary } from '../../../../packages/plugin-sdk/src/index';
import { currentLocale, tr } from './locale';
import { providerLabel } from './settingsLabels';

export type ProviderCatalogGroupId =
  | 'recommended'
  | 'account'
  | 'plans'
  | 'api'
  | 'aggregators'
  | 'local'
  | 'custom';

export type ProviderCatalogGroup = {
  id: ProviderCatalogGroupId;
  label: string;
  providers: SettingsProviderSummary[];
};

const BUILTIN_CODEX_PACKAGE = 'maka.codex';
const BUILTIN_API_PACKAGE = 'maka.providers';

/**
 * Curated priority order for the Recommended group and the empty-state
 * shortlist on Models settings. Keys are `<packageId>:<name>` for built-in
 * providers so third-party plugin providers with matching names stay separate.
 */
const RECOMMENDED_ORDER = [
  `${BUILTIN_CODEX_PACKAGE}:chatgpt`,
  `${BUILTIN_API_PACKAGE}:openai`,
  `${BUILTIN_API_PACKAGE}:anthropic`,
  `${BUILTIN_API_PACKAGE}:google`,
  `${BUILTIN_API_PACKAGE}:deepseek`,
  `${BUILTIN_API_PACKAGE}:openrouter`,
] as const;

const RECOMMENDED_RANK = new Map<string, number>(
  RECOMMENDED_ORDER.map((key, index) => [key, index]),
);

const BUILTIN_PLAN_NAMES = new Set([
  'alibaba-coding-plan',
  'alibaba-coding-plan-cn',
  'alibaba-token-plan',
  'alibaba-token-plan-cn',
  'commandcode',
  'kimi-coding-plan',
  'minimax-coding-plan',
  'opencode',
  'opencode-go',
  'stepfun-ai-step-plan',
  'stepfun-step-plan',
  'tencent-coding-plan',
  'tencent-token-plan',
  'tencent-token-plan-enterprise',
  'tencent-token-plan-enterprise-intl',
  'volcengine-agent-plan',
  'volcengine-coding-plan',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai-coding-plan',
  'zhipu-coding-plan',
]);

const BUILTIN_API_NAMES = new Set([
  'alibaba',
  'alibaba-cn',
  'cerebras',
  'cloudflare-workers-ai',
  'cohere',
  'MiniMax',
  'MiniMax-cn',
  'mistral',
  'moonshot',
  'moonshot-global',
  'nvidia',
  'ollama-cloud',
  'stepfun',
  'stepfun-ai',
  'tencent-tokenhub',
  'volcengine-ark',
  'xai',
  'xiaomi',
  'zai',
  'zhipu',
]);

const BUILTIN_AGGREGATOR_NAMES = new Set([
  'aihubmix',
  'anthropic-compatible',
  'deepinfra',
  'fireworks-ai',
  'groq',
  'huggingface',
  'magpie',
  'modelscope',
  'new-api',
  'openai-compatible',
  'openai-responses-compatible',
  'siliconflow',
  'sub2api',
  'togetherai',
  'vercel',
  'zenmux',
]);

const BUILTIN_LOCAL_NAMES = new Set(['ollama', 'lm-studio', 'localai', 'vllm']);

const GROUP_ORDER: readonly ProviderCatalogGroupId[] = [
  'recommended',
  'account',
  'plans',
  'api',
  'aggregators',
  'local',
  'custom',
];

export const providerIdentityKey = (provider: SettingsProviderSummary) =>
  JSON.stringify([
    provider.identity.packageId,
    provider.identity.entryId,
    provider.identity.scope,
    provider.identity.name,
  ]);

const isInteractive = (provider: SettingsProviderSummary) =>
  provider.authentication.some((method) => method.interactive);

const isBuiltinPackage = (provider: SettingsProviderSummary) =>
  provider.identity.scope === 'profile' &&
  provider.identity.packageId === provider.identity.entryId &&
  (provider.identity.packageId === BUILTIN_API_PACKAGE ||
    provider.identity.packageId === BUILTIN_CODEX_PACKAGE);

const builtinKey = (provider: SettingsProviderSummary) =>
  `${provider.identity.packageId}:${provider.identity.name}`;

export function recommendedRank(provider: SettingsProviderSummary): number | null {
  if (!isBuiltinPackage(provider)) return null;
  const exact = RECOMMENDED_RANK.get(builtinKey(provider));
  if (exact !== undefined) return exact;
  if (!provider.customEndpoint && isInteractive(provider)) return RECOMMENDED_ORDER.length;
  return null;
}

export function classifyProviderGroup(provider: SettingsProviderSummary): ProviderCatalogGroupId {
  if (recommendedRank(provider) !== null) return 'recommended';
  if (isBuiltinPackage(provider) && provider.identity.packageId === BUILTIN_API_PACKAGE) {
    const name = provider.identity.name;
    if (BUILTIN_PLAN_NAMES.has(name)) return 'plans';
    if (BUILTIN_LOCAL_NAMES.has(name)) return 'local';
    if (BUILTIN_AGGREGATOR_NAMES.has(name)) return 'aggregators';
    if (BUILTIN_API_NAMES.has(name)) return 'api';
    if (provider.customEndpoint) return 'aggregators';
    return 'api';
  }
  // Third-party plugin providers keep the generic capability fallback.
  if (!provider.customEndpoint && isInteractive(provider)) return 'account';
  if (provider.customEndpoint) return 'custom';
  return 'api';
}

export function providerGroupLabel(group: ProviderCatalogGroupId): string {
  switch (group) {
    case 'recommended':
      return tr('Recommended');
    case 'account':
      return tr('Account sign-in');
    case 'plans':
      return tr('Subscription plans');
    case 'api':
      return tr('API providers');
    case 'aggregators':
      return tr('Aggregators & custom endpoints');
    case 'local':
      return tr('Local');
    case 'custom':
      return tr('Custom endpoints');
  }
}

export function compareProvidersByLabel(
  a: SettingsProviderSummary,
  b: SettingsProviderSummary,
  locale = currentLocale(),
): number {
  return (
    providerLabel(a.label).localeCompare(providerLabel(b.label), locale) ||
    providerIdentityKey(a).localeCompare(providerIdentityKey(b))
  );
}

/**
 * Curated recommended shortlist for first-run Models settings and the top
 * group of the provider catalog, ordered by priority with interactive account
 * sign-ins first.
 */
export function recommendedProviders(
  providers: readonly SettingsProviderSummary[],
  locale = currentLocale(),
): SettingsProviderSummary[] {
  return providers
    .filter((provider) => recommendedRank(provider) !== null)
    .sort(
      (a, b) =>
        (recommendedRank(a) ?? Number.MAX_SAFE_INTEGER) -
          (recommendedRank(b) ?? Number.MAX_SAFE_INTEGER) || compareProvidersByLabel(a, b, locale),
    );
}

/**
 * Groups providers into mental-model sections for browse mode, omitting empty
 * groups. Each provider appears in exactly one group so list keys, keyboard
 * selection, and accessibility labels stay unique.
 */
export function groupProviders(
  providers: readonly SettingsProviderSummary[],
  locale = currentLocale(),
): ProviderCatalogGroup[] {
  const buckets = new Map<ProviderCatalogGroupId, SettingsProviderSummary[]>();
  for (const provider of providers) {
    const group = classifyProviderGroup(provider);
    const items = buckets.get(group);
    if (items) items.push(provider);
    else buckets.set(group, [provider]);
  }
  const groups: ProviderCatalogGroup[] = [];
  for (const id of GROUP_ORDER) {
    const items = buckets.get(id);
    if (!items?.length) continue;
    const sorted =
      id === 'recommended'
        ? recommendedProviders(items, locale)
        : [...items].sort((a, b) => compareProvidersByLabel(a, b, locale));
    groups.push({ id, label: providerGroupLabel(id), providers: sorted });
  }
  return groups;
}

export function providerShortlistDescription(provider: SettingsProviderSummary): string {
  return isInteractive(provider) ? tr('Account sign-in') : tr('API key');
}
