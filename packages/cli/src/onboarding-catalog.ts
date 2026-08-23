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
  CATALOG_PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  providerAuthSupportsApiKey,
} from '@maka/core/llm-connections';
import type { OnboardableProvider } from './pi-tui-contracts.js';

export function listApiKeyOnboardableProviders(): OnboardableProvider[] {
  return CATALOG_PROVIDER_TYPES.filter((providerType) => providerAuthSupportsApiKey(providerType))
    .map((providerType) => {
      const definition = PROVIDER_DEFAULTS[providerType];
      return {
        providerType,
        label: definition.label,
        authKind: definition.authKind as 'api_key' | 'optional_api_key',
        requiresBaseUrl: !definition.baseUrl,
        fallbackModels: definition.fallbackModels,
      };
    })
    .filter((provider) => !provider.requiresBaseUrl);
}
