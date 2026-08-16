import type { ModelInfo, ProviderType } from '@maka/core/llm-connections';

interface ConnectionModelAdmissionInput {
  readonly providerType: ProviderType;
  readonly enabledModelIds: readonly string[];
  readonly models: readonly ModelInfo[];
}

/** Resolves one executable model without treating provider metadata as connection inventory. */
export function resolveAdmittedConnectionModel(
  connection: ConnectionModelAdmissionInput,
  modelId: string,
): ModelInfo | undefined {
  if (!connection.enabledModelIds.includes(modelId)) return undefined;
  const discovered = connection.models.find(({ id }) => id === modelId);
  if (discovered) return discovered;
  if (
    connection.models.length === 0 &&
    connection.providerType === 'deepseek' &&
    modelId === 'deepseek-v4-flash'
  ) {
    return { id: modelId };
  }
  return undefined;
}
