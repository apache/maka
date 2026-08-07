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
