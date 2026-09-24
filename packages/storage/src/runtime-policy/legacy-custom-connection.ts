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
  return {
    ...item,
    providerType: 'custom',
    defaultApiProtocol: LEGACY_CUSTOM_PROVIDER_PROTOCOLS[providerType],
  };
}
