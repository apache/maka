import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  PROVIDER_DEFAULTS,
  type LlmConnection,
  type ModelInfo,
  type ProviderType,
} from '@maka/core';
import type { RunHarborCellEnv } from './headless-run-env.js';

/**
 * The protocol a connection actually carries, given what was advertised.
 *
 * Only two providers let an advertised protocol pick the wire: GitHub Copilot,
 * where the account discovers it, and the Kimi Coding Plan, which is sold as
 * two protocols against one account. Everywhere else the model's own catalog
 * entry decides, and an advertised value is dropped.
 *
 * Anything deciding what wire the Maka runtime will dial has to apply this same
 * rule, or it decides about a connection the runtime will never build. The
 * proxy resolves its SSE parser that way (`providerProxyUsageProtocol`), and
 * honouring the override where the runtime drops it is the same wrong-wire
 * failure — a proxy parsing Chat while the runtime dials Responses records
 * every request interrupted with no usage.
 */
export function selectedModelApiProtocol(
  provider: ProviderType,
  advertised: ModelInfo['apiProtocol'],
): ModelInfo['apiProtocol'] {
  return provider === 'github-copilot' || provider === 'kimi-coding-plan' ? advertised : undefined;
}

export interface ProviderCredentialEnv {
  apiKeys: readonly string[];
  apiKeyFile: string;
  baseUrls: readonly string[];
  accountId?: string;
}

const PROVIDER_CREDENTIAL_ENV = {
  anthropic: env('ANTHROPIC', ['ANTHROPIC_BASE_URL']),
  'kimi-coding-plan': env('ANTHROPIC'),
  'minimax-coding-plan': env('MINIMAX_CODING_PLAN', ['MINIMAX_CODING_PLAN_BASE_URL']),
  openai: env('OPENAI', ['OPENAI_BASE_URL']),
  opencode: env('OPENCODE', ['OPENCODE_BASE_URL']),
  'opencode-go': env('OPENCODE', ['OPENCODE_GO_BASE_URL']),
  google: env('GOOGLE', ['GOOGLE_BASE_URL']),
  deepseek: env('DEEPSEEK', ['DEEPSEEK_BASE_URL', 'OPENAI_BASE_URL'], ['OPENAI_API_KEY']),
  moonshot: env('MOONSHOT', ['MOONSHOT_BASE_URL'], ['OPENAI_API_KEY']),
  'zai-coding-plan': env('ZAI', ['ZAI_BASE_URL'], ['ZAI_CODING_CN_API_KEY', 'OPENAI_API_KEY']),
  MiniMax: env('MINIMAX', ['MINIMAX_BASE_URL']),
  'MiniMax-cn': env('MINIMAX', ['MINIMAX_BASE_URL']),
  siliconflow: env('SILICONFLOW', ['SILICONFLOW_BASE_URL']),
  vercel: env('AI_GATEWAY', ['AI_GATEWAY_BASE_URL']),
  xai: env('XAI', ['XAI_BASE_URL']),
  zai: env('ZAI', ['ZAI_BASE_URL']),
  xiaomi: env('XIAOMI', ['XIAOMI_BASE_URL']),
  cerebras: env('CEREBRAS', ['CEREBRAS_BASE_URL']),
  mistral: env('MISTRAL', ['MISTRAL_BASE_URL']),
  cohere: env('COHERE', ['COHERE_BASE_URL']),
  huggingface: {
    apiKeys: ['HF_TOKEN'],
    apiKeyFile: 'HF_TOKEN_FILE',
    baseUrls: ['HUGGINGFACE_BASE_URL'],
  },
  zenmux: env('ZENMUX', ['ZENMUX_BASE_URL']),
  togetherai: env('TOGETHER', ['TOGETHER_BASE_URL']),
  deepinfra: env('DEEPINFRA', ['DEEPINFRA_BASE_URL']),
  groq: env('GROQ', ['GROQ_BASE_URL']),
  openrouter: env('OPENROUTER', ['OPENROUTER_BASE_URL']),
  alibaba: env('DASHSCOPE', ['DASHSCOPE_BASE_URL']),
  'cloudflare-workers-ai': env(
    'CLOUDFLARE',
    ['CLOUDFLARE_WORKERS_AI_BASE_URL'],
    [],
    'CLOUDFLARE_ACCOUNT_ID',
  ),
  'fireworks-ai': env('FIREWORKS', ['FIREWORKS_BASE_URL']),
  nvidia: env('NVIDIA', ['NVIDIA_BASE_URL']),
  'ollama-cloud': env('OLLAMA'),
  'tencent-tokenhub': env('TENCENT_TOKENHUB', ['TENCENT_TOKENHUB_BASE_URL']),
  stepfun: env('STEPFUN', ['STEPFUN_BASE_URL']),
  'stepfun-step-plan': env('STEPFUN_STEP_PLAN', ['STEPFUN_STEP_PLAN_BASE_URL']),
  'stepfun-ai': env('STEPFUN_AI', ['STEPFUN_AI_BASE_URL']),
  'stepfun-ai-step-plan': env('STEPFUN_AI_STEP_PLAN', ['STEPFUN_AI_STEP_PLAN_BASE_URL']),
  'volcengine-ark': env('ARK', ['ARK_BASE_URL']),
  localai: env('LOCALAI', ['LOCALAI_BASE_URL']),
  'openai-compatible': env('OPENAI', ['OPENAI_BASE_URL']),
  'claude-subscription': env('ANTHROPIC'),
  'openai-codex': {
    apiKeys: ['OPENAI_CODEX_OAUTH_TOKEN'],
    apiKeyFile: 'OPENAI_CODEX_OAUTH_TOKEN_FILE',
    baseUrls: [],
  },
  'github-copilot': {
    apiKeys: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    apiKeyFile: 'COPILOT_GITHUB_TOKEN_FILE',
    baseUrls: [],
  },
} satisfies Partial<Record<ProviderType, ProviderCredentialEnv>>;

const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN|SECRET|CREDENTIALS?)(?:_|$)|PASSWORD$/i;

export function providerCredentialEnv(provider: string): ProviderCredentialEnv | undefined {
  return PROVIDER_CREDENTIAL_ENV[provider as keyof typeof PROVIDER_CREDENTIAL_ENV];
}

export function requireProviderCredentialEnv(provider: string): ProviderCredentialEnv {
  const definition = providerCredentialEnv(provider);
  if (!definition) throw new Error(`provider does not support API key files: ${provider}`);
  return definition;
}

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAME.test(name);
}

export function providerBaseUrlFromEnv(
  provider: string,
  values: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (!(provider in PROVIDER_DEFAULTS)) return undefined;
  const providerType = provider as ProviderType;
  const credentialEnv = providerCredentialEnv(provider);
  for (const name of credentialEnv?.baseUrls ?? []) {
    const value = values[name]?.trim();
    if (value) return value;
  }

  const accountId = credentialEnv?.accountId ? values[credentialEnv.accountId]?.trim() : undefined;
  const template = PROVIDER_DEFAULTS[providerType].baseUrlTemplate;
  if (!accountId || !template) return undefined;
  return template.replace('${CLOUDFLARE_ACCOUNT_ID}', encodeURIComponent(accountId));
}

function env(
  prefix: string,
  baseUrls: readonly string[] = [],
  fallbackApiKeys: readonly string[] = [],
  accountId?: string,
): ProviderCredentialEnv {
  return {
    apiKeys: [`${prefix}_API_KEY`, ...fallbackApiKeys],
    apiKeyFile: `${prefix}_API_KEY_FILE`,
    baseUrls,
    ...(accountId ? { accountId } : {}),
  };
}

export interface ResolvedHarborCellAiSdkEnv {
  connection: LlmConnection;
  apiKey: string;
}

export type HostProviderAuth =
  | { kind: 'inherit' }
  | { kind: 'none' }
  | { kind: 'credential'; apiKey: string };

export interface ResolvedHostProviderAuthority {
  auth: HostProviderAuth;
  baseUrl?: string;
  apiProtocol?: ModelInfo['apiProtocol'];
}

export function providerApiKeyEnvName(provider: string): string {
  return requireProviderCredentialEnv(provider).apiKeys[0]!;
}

export function resolveHostProviderAuthority(env: RunHarborCellEnv): ResolvedHostProviderAuthority {
  const noAuth = env.MAKA_HOST_NO_AUTH === 'true';
  const rawApiKey = env.MAKA_HOST_API_KEY || undefined;
  const apiKey = rawApiKey ?? (env.MAKA_HOST_API_KEY_FILE ? readHostApiKeyFile(env) : undefined);
  if (noAuth && apiKey !== undefined) {
    throw new Error('MAKA_HOST_NO_AUTH cannot be combined with a host provider credential');
  }
  if (apiKey !== undefined && !apiKey) {
    throw new Error('host provider credential must not be empty');
  }
  const apiProtocol = modelApiProtocolFromEnv(env.MAKA_HOST_MODEL_API_PROTOCOL);
  return {
    auth: noAuth
      ? { kind: 'none' }
      : apiKey !== undefined
        ? { kind: 'credential', apiKey }
        : { kind: 'inherit' },
    ...(env.MAKA_HOST_BASE_URL ? { baseUrl: env.MAKA_HOST_BASE_URL } : {}),
    ...(apiProtocol ? { apiProtocol } : {}),
  };
}

function readHostApiKeyFile(env: RunHarborCellEnv): string {
  const path = env.MAKA_HOST_API_KEY_FILE;
  if (!path) throw new Error('MAKA_HOST_API_KEY_FILE is required for host-side Harbor cells');
  return readFileSync(path, 'utf8').trim();
}

export function providerFromEnv(value: string | undefined): ProviderType {
  if (!value || !(value in PROVIDER_DEFAULTS)) {
    throw new Error(`unsupported MAKA_PROVIDER: ${value ?? ''}`);
  }
  return value as ProviderType;
}

export function resolveHarborCellAiSdkEnv(input: {
  provider: ProviderType;
  model: string;
  env: RunHarborCellEnv;
  ts: number;
}): ResolvedHarborCellAiSdkEnv {
  const authority = resolveHostProviderAuthority(input.env);
  const connection = connectionFromEnv(input.provider, input.model, input.env, input.ts, authority);
  return {
    connection,
    apiKey:
      authority.auth.kind === 'credential'
        ? authority.auth.apiKey
        : authority.auth.kind === 'none'
          ? ''
          : apiKeyFromEnv(input.provider, input.env, connection.slug),
  };
}

function connectionFromEnv(
  provider: ProviderType,
  model: string,
  values: RunHarborCellEnv,
  ts: number,
  authority: ResolvedHostProviderAuthority,
): LlmConnection {
  const defaults = PROVIDER_DEFAULTS[provider];
  if (provider === 'kimi-coding-plan') {
    assertKimiProtocolOverride('MAKA_HOST_MODEL_API_PROTOCOL', values.MAKA_HOST_MODEL_API_PROTOCOL);
    assertKimiProtocolOverride('MAKA_MODEL_API_PROTOCOL', values.MAKA_MODEL_API_PROTOCOL);
  }
  const modelApiProtocol =
    authority.apiProtocol ?? modelApiProtocolFromEnv(values.MAKA_MODEL_API_PROTOCOL);
  if (provider === 'github-copilot' && !modelApiProtocol) {
    throw new Error('GitHub Copilot requires an account-discovered model protocol');
  }
  const selectedApiProtocol = selectedModelApiProtocol(provider, modelApiProtocol);
  return {
    slug: values.MAKA_LLM_CONNECTION_SLUG ?? provider,
    name: defaults.label,
    providerType: provider,
    baseUrl:
      authority.baseUrl ??
      values.MAKA_BASE_URL ??
      providerBaseUrlFromEnv(provider, values) ??
      defaults.baseUrl,
    defaultModel: model,
    ...(selectedApiProtocol ? { models: [{ id: model, apiProtocol: selectedApiProtocol }] } : {}),
    enabled: true,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function modelApiProtocolFromEnv(value: string | undefined): ModelInfo['apiProtocol'] {
  if (value === 'openai-chat' || value === 'openai-responses' || value === 'anthropic-messages')
    return value;
  return undefined;
}

function assertKimiProtocolOverride(name: string, value: string | undefined): void {
  if (value === undefined || value === '') return;
  if (value === 'anthropic-messages' || value === 'openai-chat') return;
  throw new Error(
    `Kimi Coding Plan protocol must be anthropic-messages or openai-chat; ${name} was ${JSON.stringify(value)}`,
  );
}

function apiKeyFromEnv(
  provider: ProviderType,
  values: RunHarborCellEnv,
  connectionSlug: string,
): string {
  const credentialEnv = providerCredentialEnv(provider);
  if (!credentialEnv) return '';
  return resolveApiKey(values, credentialEnv.apiKeys, connectionSlug);
}

// Resolve an API key from either the raw env var or its `<NAME>_FILE` companion.
// The file path is what travels through the Harbor CLI / job config, so the secret
// itself stays in a mounted file — never on a command line or in config.json.
function resolveApiKey(
  values: RunHarborCellEnv,
  names: readonly string[],
  connectionSlug?: string,
): string {
  for (const name of names) {
    const raw = values[name];
    if (raw) return raw;
    const filePath = values[`${name}_FILE`];
    if (filePath) {
      try {
        return readFileSync(filePath, 'utf8').trim();
      } catch {
        // Fall through to the next candidate (or empty) when the file is unreadable.
      }
    }
  }
  if (connectionSlug) {
    return readStoredMakaApiKey(values, connectionSlug);
  }
  return '';
}

function readStoredMakaApiKey(values: RunHarborCellEnv, connectionSlug: string): string {
  const credentialPath =
    values.MAKA_CREDENTIALS_PATH ??
    join(
      homedir(),
      'Library',
      'Application Support',
      'Maka',
      'workspaces',
      'default',
      'credentials.json',
    );
  try {
    const parsed = JSON.parse(readFileSync(credentialPath, 'utf8')) as {
      version?: unknown;
      values?: unknown;
    };
    if (parsed.version !== 1 || !parsed.values || typeof parsed.values !== 'object') return '';
    const value = (parsed.values as Record<string, unknown>)[`${connectionSlug}:apiKey`];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}
