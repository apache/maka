import type { ProviderType } from '@maka/core/llm-connections';

export const FIRST_RUN_PROVIDER_TYPES = [
  'opencode-free',
  'opencode-go',
  'openai',
  'anthropic',
] as const satisfies readonly ProviderType[];
