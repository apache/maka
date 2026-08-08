import type { ProviderType } from '@maka/core/llm-connections';
import {
  normalizeRelayModelProfiles,
  pruneRelayModelProfiles,
  type RelayModelProfiles,
} from '@maka/core/model-thinking';

/**
 * The one write-side check every connection-store boundary applies to a
 * relay profile table, regardless of write shape (create / partial update /
 * full-snapshot save): profiles exist only on openai-compatible connections
 * — a non-empty table anywhere else is the same invalid input the catalog
 * codec rejects — and only for models currently enabled on the connection,
 * so a stale key never survives the selection a store was just handed.
 */
export function relayProfilesForStorage(
  providerType: ProviderType,
  table: unknown,
  enabledModelIds: readonly string[],
): RelayModelProfiles | undefined {
  const normalized = normalizeRelayModelProfiles(table);
  if (providerType !== 'openai-compatible') {
    if (normalized !== undefined) {
      throw new Error('relay model profiles are only supported for openai-compatible connections');
    }
    return undefined;
  }
  return pruneRelayModelProfiles(normalized, enabledModelIds);
}
