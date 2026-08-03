import {
  connectionEnabledModelIds,
  type AppSettings,
  type LlmConnection,
  type SubagentPreset,
} from '@maka/core';
import type { SubagentPresetListItem } from './agent-catalog.js';

export interface ConfiguredSubagentCatalog {
  list(): Promise<SubagentPresetListItem[]>;
  resolve(id: string): Promise<SubagentPreset>;
}

export function createConfiguredSubagentCatalog(deps: {
  getSettings(): Promise<AppSettings>;
  getConnection(slug: string): Promise<LlmConnection | null>;
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
      const settings = await deps.getSettings();
      return await Promise.all(settings.subagents.presets.map(inspect));
    },
    async resolve(id) {
      const settings = await deps.getSettings();
      const preset = settings.subagents.presets.find((candidate) => candidate.id === id);
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
