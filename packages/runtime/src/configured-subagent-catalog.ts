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
import {
  AD_HOC_SUBAGENT_DESCRIPTION,
  AD_HOC_SUBAGENT_ID,
  AD_HOC_SUBAGENT_NAME,
  type AdHocSubagentPolicy,
  type SubagentPreset,
} from '@maka/core/subagent-settings';
import type { SubagentPresetListItem } from './agent-catalog.js';

export interface ConfiguredSubagentCatalog {
  list(): Promise<SubagentPresetListItem[]>;
  resolve(id: string): Promise<ResolvedSubagentPreset>;
}

export type ResolvedSubagentPreset = SubagentPreset & {
  readonly connectionId: string;
};

function syntheticAdHocPreset(adHoc: AdHocSubagentPolicy): SubagentPreset {
  return {
    id: AD_HOC_SUBAGENT_ID,
    name: AD_HOC_SUBAGENT_NAME,
    description: AD_HOC_SUBAGENT_DESCRIPTION,
    profile: adHoc.maxProfile,
    connectionSlug: adHoc.connectionSlug,
    model: adHoc.model,
    ...(adHoc.thinkingLevel !== undefined ? { thinkingLevel: adHoc.thinkingLevel } : {}),
    enabled: true,
  };
}

export function createConfiguredSubagentCatalog(deps: {
  getPresets(): Promise<readonly SubagentPreset[]>;
  getAdHocPolicy?: () => Promise<AdHocSubagentPolicy | undefined>;
  getConnection(slug: string): Promise<{
    readonly connectionId: string;
    readonly providerType: ProviderType;
    readonly enabled: boolean;
    readonly defaultModel?: string;
    readonly enabledModelIds?: readonly string[];
  } | null>;
}): ConfiguredSubagentCatalog {
  const inspect = async (
    preset: SubagentPreset,
  ): Promise<{
    readonly item: SubagentPresetListItem;
    readonly connectionId?: string;
  }> => {
    if (!preset.enabled)
      return {
        item: {
          ...preset,
          availability: { status: 'unavailable', reason: 'disabled' },
        },
      };
    const connection = await deps.getConnection(preset.connectionSlug);
    if (!connection) {
      return {
        item: {
          ...preset,
          availability: { status: 'unavailable', reason: 'missing_connection' },
        },
      };
    }
    // Before `enabled`: a retained retired connection stays enabled — the row
    // exists so the credential is visible and deletable — but a preset routed
    // through it can never execute, so spawning or provisioning a graph with
    // it would persist a child that is unexecutable from birth.
    if (isRetiredProvider(connection.providerType)) {
      return {
        item: {
          ...preset,
          availability: { status: 'unavailable', reason: 'provider_retired' },
        },
      };
    }
    if (!connection.enabled) {
      return {
        item: {
          ...preset,
          availability: { status: 'unavailable', reason: 'connection_disabled' },
        },
      };
    }
    if (!connectionEnabledModelIds(connection).includes(preset.model)) {
      return {
        item: {
          ...preset,
          availability: { status: 'unavailable', reason: 'model_disabled' },
        },
      };
    }
    return {
      item: { ...preset, availability: { status: 'available' } },
      connectionId: connection.connectionId,
    };
  };

  return {
    async list() {
      const configured = (await Promise.all((await deps.getPresets()).map(inspect))).map(
        ({ item }) => item,
      );
      const adHoc = deps.getAdHocPolicy ? await deps.getAdHocPolicy() : undefined;
      if (!adHoc?.enabled) return configured;
      const synthetic = syntheticAdHocPreset(adHoc);
      return [...configured, (await inspect(synthetic)).item];
    },
    async resolve(id) {
      const adHoc = deps.getAdHocPolicy ? await deps.getAdHocPolicy() : undefined;
      if (id === AD_HOC_SUBAGENT_ID && !adHoc?.enabled) {
        throw new Error(`Unknown subagent_id "${id}". Call agent_list before spawning.`);
      }
      const preset: SubagentPreset | undefined =
        id === AD_HOC_SUBAGENT_ID
          ? syntheticAdHocPreset(adHoc!)
          : (await deps.getPresets()).find((candidate) => candidate.id === id);
      if (!preset) throw new Error(`Unknown subagent_id "${id}". Call agent_list before spawning.`);
      const inspected = await inspect(preset);
      if (inspected.item.availability.status !== 'available') {
        throw new Error(
          `Subagent preset "${id}" is unavailable: ${inspected.item.availability.reason}.`,
        );
      }
      if (!inspected.connectionId) throw new Error(`Subagent preset "${id}" lost its Connection.`);
      const { availability: _availability, ...resolved } = inspected.item;
      return { ...resolved, connectionId: inspected.connectionId };
    },
  };
}
