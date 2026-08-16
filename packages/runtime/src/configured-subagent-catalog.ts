import { connectionEnabledModelIds } from '@maka/core/llm-connections';
import { type SubagentPreset } from '@maka/core/subagent-settings';
import type { SubagentPresetListItem } from './agent-catalog.js';

export interface ConfiguredSubagentCatalog {
  list(): Promise<SubagentPresetListItem[]>;
  resolve(id: string): Promise<SubagentPreset>;
}

export function createConfiguredSubagentCatalog(deps: {
  getPresets(): Promise<readonly SubagentPreset[]>;
  getConnection(slug: string): Promise<{
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
