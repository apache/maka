/**
 * Bootstrap connection seed decision.
 *
 * Decides which provider connections a fresh Maka install seeds before the
 * user configures anything, and which one is the default. Pure & sync — the
 * caller owns the connectionStore writes and the change event.
 *
 * `opencode-free` is seeded unconditionally so Maka is usable out of the box
 * with zero credentials: it is an anonymous OpenCode Zen free-tier provider
 * (no API key; the runtime omits Authorization and the server treats the
 * request as anonymous, matching the upstream OpenCode client). Env-keyed
 * providers layer on top and take the default when present, preserving the
 * prior env-bootstrap precedence (Anthropic before OpenAI).
 */

import type { LlmConnection, ProviderType, UpdateConnectionInput } from './llm-connections.js';

export const OPENCODE_FREE_DEFAULT_MODEL = 'nemotron-3-ultra-free';
export const OPENCODE_FREE_LEGACY_DEFAULT_MODEL = 'big-pickle';
export const OPENCODE_FREE_BOOTSTRAP_VERSION = 2;

const OPENCODE_FREE_BOOTSTRAP_EXTRAS = {
  makaBootstrap: { id: 'opencode-free', version: OPENCODE_FREE_BOOTSTRAP_VERSION },
} as const;

export interface BootstrapConnectionSeed {
  readonly slug: string;
  readonly name: string;
  readonly providerType: ProviderType;
  readonly defaultModel: string;
  readonly isDefault: boolean;
  readonly extras?: Record<string, unknown>;
}

export interface BootstrapEnv {
  readonly ANTHROPIC_API_KEY?: string;
  readonly OPENAI_API_KEY?: string;
}

const OPENCODE_FREE_SEED: Omit<BootstrapConnectionSeed, 'isDefault'> = {
  slug: 'opencode-free',
  name: 'OpenCode Free',
  providerType: 'opencode-free',
  defaultModel: OPENCODE_FREE_DEFAULT_MODEL,
  extras: OPENCODE_FREE_BOOTSTRAP_EXTRAS,
};

const ANTHROPIC_ENV_SEED: Omit<BootstrapConnectionSeed, 'isDefault'> = {
  slug: 'env-anthropic',
  name: 'Anthropic (env)',
  providerType: 'anthropic',
  defaultModel: 'claude-sonnet-4-5-20250929',
};

const OPENAI_ENV_SEED: Omit<BootstrapConnectionSeed, 'isDefault'> = {
  slug: 'env-openai',
  name: 'OpenAI (env)',
  providerType: 'openai',
  defaultModel: 'gpt-4o-mini',
};

/**
 * Resolve the bootstrap connection seeds for a fresh install.
 *
 * `opencode-free` is always seeded as the zero-credential fallback. When an
 * env provider key is present that provider is added and takes the default
 * (Anthropic wins over OpenAI, and OpenAI is not seeded when Anthropic is
 * present — matching the original bootstrap's `return` after Anthropic).
 */
export function resolveBootstrapConnections(env: BootstrapEnv): readonly BootstrapConnectionSeed[] {
  const seeds: BootstrapConnectionSeed[] = [];

  const freeDefault = !env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY;
  seeds.push({ ...OPENCODE_FREE_SEED, isDefault: freeDefault });

  if (env.ANTHROPIC_API_KEY) {
    seeds.push({ ...ANTHROPIC_ENV_SEED, isDefault: true });
    return seeds;
  }
  if (env.OPENAI_API_KEY) {
    seeds.push({ ...OPENAI_ENV_SEED, isDefault: true });
  }
  return seeds;
}

/**
 * Migrate only the exact connection shape written by Maka's historical
 * OpenCode Free bootstrap. Any user-visible customization makes ownership
 * ambiguous and therefore fails closed.
 */
export function resolveOpenCodeFreeBootstrapMigration(
  connection: LlmConnection,
): UpdateConnectionInput | undefined {
  if (
    connection.slug !== 'opencode-free' ||
    connection.name !== 'OpenCode Free' ||
    connection.providerType !== 'opencode-free' ||
    connection.baseUrl !== undefined ||
    connection.defaultModel !== OPENCODE_FREE_LEGACY_DEFAULT_MODEL ||
    connection.enabled !== true ||
    connection.enabledModelIds?.length !== 1 ||
    connection.enabledModelIds[0] !== OPENCODE_FREE_LEGACY_DEFAULT_MODEL ||
    connection.models !== undefined ||
    connection.extras !== undefined
  ) {
    return undefined;
  }

  return {
    defaultModel: OPENCODE_FREE_DEFAULT_MODEL,
    enabledModelIds: [OPENCODE_FREE_DEFAULT_MODEL],
    extras: OPENCODE_FREE_BOOTSTRAP_EXTRAS,
  };
}
