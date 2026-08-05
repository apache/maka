import type { OAuthLoginProvider } from '@maka/runtime-host/protocol';

/** Stable Desktop connection identities for Host-supported interactive OAuth providers. */
export const INTERACTIVE_OAUTH_CONNECTION_SLUGS = {
  'claude-subscription': 'claude-subscription',
  'openai-codex': 'codex-subscription',
  'xai-oauth': 'xai-oauth',
} as const satisfies Readonly<Record<OAuthLoginProvider, string>>;

export const CLAUDE_SUBSCRIPTION_CONNECTION_SLUG =
  INTERACTIVE_OAUTH_CONNECTION_SLUGS['claude-subscription'];
export const CODEX_SUBSCRIPTION_CONNECTION_SLUG =
  INTERACTIVE_OAUTH_CONNECTION_SLUGS['openai-codex'];
export const XAI_OAUTH_CONNECTION_SLUG = INTERACTIVE_OAUTH_CONNECTION_SLUGS['xai-oauth'];
