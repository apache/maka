import type { OAuthLoginProvider } from '@maka/runtime-host/protocol';

/** Stable Desktop connection identities for Host-supported interactive OAuth providers. */
export const INTERACTIVE_OAUTH_CONNECTION_SLUGS = {
  'openai-codex': 'codex-subscription',
  'xai-oauth': 'xai-oauth',
  // Shared with the local `gh` credential import so both routes to a Copilot
  // account land on one Connection instead of two.
  'github-copilot': 'github-copilot',
} as const satisfies Readonly<Record<OAuthLoginProvider, string>>;
