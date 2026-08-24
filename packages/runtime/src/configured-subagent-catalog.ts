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

import { connectionEnabledModelIds, type ProviderType } from '@maka/core/llm-connections';
import { isRetiredProvider } from '@maka/core/provider-registry';
import { type SubagentPreset } from '@maka/core/subagent-settings';
import type { SubagentPresetListItem } from './agent-catalog.js';

export interface ConfiguredSubagentCatalog {
  list(): Promise<SubagentPresetListItem[]>;
  resolve(id: string): Promise<SubagentPreset>;
}

export function createConfiguredSubagentCatalog(deps: {
  getPresets(): Promise<readonly SubagentPreset[]>;
  getConnection(slug: string): Promise<{
    readonly providerType: ProviderType;
    readonly enabled: boolean;
    readonly defaultModel?: string;
    readonly enabledModelIds?: readonly string[];
  } | null>;
}): ConfiguredSubagentCatalog {
  const inspect = async (preset: SubagentPreset): Promise<SubagentPresetListItem> => {
    if (!preset.enabled)
      return {
        ...preset,
        availability: { status: 'unavailable', reason: 'disabled' },
      };
    const connection = await deps.getConnection(preset.connectionSlug);
    if (!connection) {
      return {
        ...preset,
        availability: { status: 'unavailable', reason: 'missing_connection' },
      };
    }
    // Before `enabled`: a retained retired connection stays enabled — the row
    // exists so the credential is visible and deletable — but a preset routed
    // through it can never execute, so spawning or provisioning a graph with
    // it would persist a child that is unexecutable from birth.
    if (isRetiredProvider(connection.providerType)) {
      return {
        ...preset,
        availability: { status: 'unavailable', reason: 'provider_retired' },
      };
    }
    if (!connection.enabled) {
      return {
        ...preset,
        availability: { status: 'unavailable', reason: 'connection_disabled' },
      };
    }
    if (!connectionEnabledModelIds(connection).includes(preset.model)) {
      return {
        ...preset,
        availability: { status: 'unavailable', reason: 'model_disabled' },
      };
    }
    return { ...preset, availability: { status: 'available' } };
  };

  return {
    async list() {
      return await Promise.all((await deps.getPresets()).map(inspect));
    },
    async resolve(id) {
      const preset = (await deps.getPresets()).find((candidate) => candidate.id === id);
      if (!preset) throw new Error(`Unknown subagent_id "${id}". Call agent_list before spawning.`);
      const inspected = await inspect(preset);
      if (inspected.availability.status !== 'available') {
        throw new Error(
          `Subagent preset "${id}" is unavailable: ${inspected.availability.reason}.`,
        );
      }
      const { availability: _availability, ...resolved } = inspected;
      return resolved;
    },
  };
}
