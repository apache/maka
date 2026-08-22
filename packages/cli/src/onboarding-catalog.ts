import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  providerAuthSupportsApiKey,
} from '@maka/core/llm-connections';
import type { OnboardableProvider } from './pi-tui-contracts.js';

export function listApiKeyOnboardableProviders(): OnboardableProvider[] {
  // Custom relays have no built-in base URL and stay listed: `requiresBaseUrl`
  // tells the wizard to collect an endpoint before the API key. The original
  // phase-1 wizard filtered every empty-baseUrl provider out because it had no
  // base-URL step to offer (#1254); that step exists now (#3405). Providers
  // whose endpoint is derived rather than user-supplied (cloudflare-workers-ai
  // interpolates an account id into a URL template) are still excluded — a
  // plain base-URL prompt cannot onboard them.
  return CATALOG_PROVIDER_TYPES.filter((providerType) => {
    if (!providerAuthSupportsApiKey(providerType)) return false;
    const definition = PROVIDER_DEFAULTS[providerType];
    return Boolean(definition.baseUrl) || definition.category === 'custom';
  }).map((providerType) => {
    const definition = PROVIDER_DEFAULTS[providerType];
    return {
      providerType,
      label: definition.label,
      authKind: definition.authKind as 'api_key' | 'optional_api_key',
      requiresBaseUrl: !definition.baseUrl,
      fallbackModels: definition.fallbackModels,
    };
  });
}
