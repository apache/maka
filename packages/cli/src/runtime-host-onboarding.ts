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

import { isRetiredProvider } from '@maka/core/provider-registry';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import {
  readRuntimeHostConnectionCatalog,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { listApiKeyOnboardableProviders } from './onboarding-catalog.js';
import type {
  MakaOnboardingSurface,
  ModelChoice,
  OnboardingProviderEntry,
} from './pi-tui-contracts.js';

/** Adapt the TUI onboarding workflow to Host-owned verification and persistence. */
export function createRuntimeHostOnboardingSurface(
  connection: RuntimeHostConnection,
): MakaOnboardingSurface {
  return {
    listProviders: async () => projectProviders(await readRuntimeHostConnectionCatalog(connection)),
    verify: async (input) => {
      try {
        const result = await connection.request('connection.onboarding.verify', {
          target: input.target,
          apiKey: trimmedOrNull(input.apiKey),
          baseUrl: trimmedOrNull(input.baseUrl),
        });
        if (result.kind === 'verified') return { kind: 'ok', models: [...result.models] };
        return result;
      } catch {
        return { kind: 'unavailable' };
      }
    },
    save: async (input) => {
      try {
        const result = await connection.request('connection.onboarding.save', {
          target: input.target,
          apiKey: trimmedOrNull(input.apiKey),
          baseUrl: trimmedOrNull(input.baseUrl),
          enabledModelIds: [...input.enabledModelIds],
        });
        if (result.kind !== 'saved') {
          return result;
        }
        try {
          return {
            kind: 'ok',
            connection: result.connection,
            refresh: {
              kind: 'ok',
              modelChoices: projectRuntimeHostModelChoices(
                await readRuntimeHostConnectionCatalog(connection),
              ),
            },
          };
        } catch {
          // Saving and refreshing are separate outcomes. The Host has already
          // committed this exact Connection, so a transient catalog read must
          // never turn a successful create into a retryable create failure.
          return {
            kind: 'ok',
            connection: result.connection,
            refresh: {
              kind: 'failed',
              reason: 'catalog_unavailable',
            },
          };
        }
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}

export function projectRuntimeHostModelChoices(catalog: ConnectionCatalogSnapshot): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const connection of catalog.connections) {
    // A retained retired connection stays enabled so its credential remains
    // visible and deletable, but every send through it is refused — offering
    // its models here would only let the user pick something that fails on
    // selection.
    if (!connection.enabled || isRetiredProvider(connection.providerType)) continue;
    const modelsById = new Map(connection.models.map((model) => [model.id, model]));
    const ids = new Set(connection.enabledModelIds);
    if (catalog.defaultTarget?.connectionId === connection.connectionId) {
      ids.add(catalog.defaultTarget.modelId);
    }
    for (const model of ids) {
      choices.push({
        connectionId: connection.connectionId,
        connectionSlug: connection.slug,
        connectionName: connection.name,
        providerType: connection.providerType,
        model,
        displayName: modelsById.get(model)?.displayName,
        isDefaultConnection: catalog.defaultTarget?.connectionId === connection.connectionId,
        contextWindow: modelsById.get(model)?.contextWindow,
      });
    }
  }
  return choices;
}

export function projectProviders(catalog: ConnectionCatalogSnapshot): OnboardingProviderEntry[] {
  const entries: OnboardingProviderEntry[] = [];
  for (const provider of listApiKeyOnboardableProviders()) {
    for (const connection of catalog.connections) {
      if (connection.providerType !== provider.providerType) continue;
      entries.push({
        ...provider,
        target: { kind: 'existing', connectionId: connection.connectionId },
        label: `${connection.name} · ${connection.slug}`,
        connectionSlug: connection.slug,
        enabledModelIds: [...connection.enabledModelIds],
      });
    }
    entries.push({
      ...provider,
      target: { kind: 'create', providerType: provider.providerType },
      label: provider.label,
      enabledModelIds: [],
    });
  }
  return entries;
}

function trimmedOrNull(value: string | undefined): string | null {
  const secret = value?.trim() ?? '';
  return secret.length === 0 ? null : secret;
}
