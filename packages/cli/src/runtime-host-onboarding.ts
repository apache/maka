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

import { deriveConnectionSlug, offerableCatalogEntries } from '@maka/core/llm-connections';
import type { RuntimeHostConnectionCatalogSnapshot as ConnectionCatalogSnapshot } from '@maka/runtime-host/client';
import {
  readRuntimeHostConnectionCatalog,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { listApiKeyOnboardableProviders } from './onboarding-catalog.js';
import type {
  ConnectionIdentity,
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
          const catalog = await readRuntimeHostConnectionCatalog(connection);
          return {
            kind: 'ok',
            connection: result.connection,
            refresh: {
              kind: 'ok',
              modelChoices: projectRuntimeHostModelChoices(catalog),
              connectionIdentities: projectRuntimeHostConnectionIdentities(catalog),
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
    // Which models are offerable, and what is true about them, are both the
    // Host's answers. A TUI older or newer than the Host must not re-derive
    // either against its own registry and bundled metadata — that is how the
    // same model came to be selectable here and refused elsewhere. A retained
    // retired connection drops out through the same gate: its entries are not
    // chat-capable, so none of them reach this list.
    for (const entry of offerableCatalogEntries(connection)) {
      choices.push({
        connectionId: connection.connectionId,
        connectionSlug: connection.slug,
        connectionName: connection.name,
        providerType: connection.providerType,
        model: entry.id,
        displayName: entry.displayName,
        isDefaultConnection: catalog.defaultTarget?.connectionId === connection.connectionId,
        contextWindow: entry.contextWindow,
        thinkingLevels: entry.thinkingLevels,
      });
    }
  }
  return choices;
}

export function projectRuntimeHostConnectionIdentities(
  catalog: ConnectionCatalogSnapshot,
): ConnectionIdentity[] {
  return catalog.connections.map((connection) => ({
    connectionId: connection.connectionId,
    connectionSlug: connection.slug,
    enabled: connection.enabled,
  }));
}

export function projectProviders(catalog: ConnectionCatalogSnapshot): OnboardingProviderEntry[] {
  const entries: OnboardingProviderEntry[] = [];
  const existingSlugs = catalog.connections.map((connection) => connection.slug);
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
      suggestedSlug: deriveConnectionSlug(provider.providerType, existingSlugs),
      enabledModelIds: [],
    });
  }
  return entries;
}

function trimmedOrNull(value: string | undefined): string | null {
  const secret = value?.trim() ?? '';
  return secret.length === 0 ? null : secret;
}
