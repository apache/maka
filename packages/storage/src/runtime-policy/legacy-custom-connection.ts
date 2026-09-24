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

import type { ModelApiProtocol } from '@maka/core/llm-connections';

const LEGACY_CUSTOM_PROVIDER_PROTOCOLS: Readonly<Record<string, ModelApiProtocol>> = {
  'openai-compatible': 'openai-chat',
  'openai-responses-compatible': 'openai-responses',
  'anthropic-compatible': 'anthropic-messages',
};

/** Rewrites a raw record naming one of the per-protocol custom types that `custom` replaced. */
export function upgradeLegacyCustomProvider<T>(item: T): T {
  if (typeof item !== 'object' || item === null) return item;
  const providerType = Reflect.get(item, 'providerType');
  if (
    typeof providerType !== 'string' ||
    !Object.hasOwn(LEGACY_CUSTOM_PROVIDER_PROTOCOLS, providerType)
  ) {
    return item;
  }
  const upgraded = {
    ...item,
    providerType: 'custom',
    defaultApiProtocol: LEGACY_CUSTOM_PROVIDER_PROTOCOLS[providerType],
  };
  return providerType === 'anthropic-compatible' ? keepInferredHostedSearch(upgraded) : upgraded;
}

// `anthropic-compatible` inferred hosted web search for this one model; `custom`
// only honors a declaration, so a migrated catalog row gets one written for it.
const HOSTED_SEARCH_MODEL = 'deepseek-v4-flash';

function keepInferredHostedSearch<T extends object>(row: T): T {
  const enabled = Reflect.get(row, 'enabledModelIds');
  if (
    !Array.isArray(Reflect.get(row, 'models')) ||
    !Array.isArray(enabled) ||
    !enabled.includes(HOSTED_SEARCH_MODEL)
  ) {
    return row;
  }
  const overrides: Record<string, { capabilities?: Record<string, unknown> }> =
    Reflect.get(row, 'modelOverrides') ?? {};
  const current = overrides[HOSTED_SEARCH_MODEL] ?? {};
  if (current.capabilities?.webSearch !== undefined) return row;
  return {
    ...row,
    modelOverrides: {
      ...overrides,
      [HOSTED_SEARCH_MODEL]: {
        ...current,
        capabilities: { ...current.capabilities, webSearch: true },
      },
    },
  };
}
