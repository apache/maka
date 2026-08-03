/**
 * Pure helpers for the Codex subscription OAuth service. Split
 * out from `openai-codex-service.ts` so unit tests can
 * import them without dragging in the `electron` ESM module
 * (which is not loadable from node --test directly).
 *
 * Endpoint constants live here too; the service module re-exports
 * them so there is exactly one source of truth.
 *
 * Authorization is the ChatGPT device-code flow (`deviceauth/*` on
 * auth.openai.com/api/accounts), the same flow the official Codex
 * CLI uses — no local loopback listener, no fixed callback port.
 */

// =============================================================
// Endpoints — pinned to the official codex CLI device-auth flow
// (codex-rs login/src/device_code_auth.rs).
// =============================================================
export const CODEX_OAUTH_CONFIG = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  deviceAuthBaseUrl: 'https://auth.openai.com/api/accounts',
  deviceVerifyUrl: 'https://auth.openai.com/codex/device',
  deviceRedirectUri: 'https://auth.openai.com/deviceauth/callback',
  scopes: 'openid profile email offline_access',
} as const;

// =============================================================
// JWT claim extraction. The Codex access token is a JWT carrying
// the OpenAI-specific `chatgpt_account_id` claim used downstream
// by the responses API.
// =============================================================

export interface CodexAccountClaims {
  accountId: string;
  email?: string;
  picture?: string;
  plan?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = parts[1]!;
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  const standard = padded.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = Buffer.from(standard, 'base64').toString('utf8');
  return JSON.parse(decoded) as Record<string, unknown>;
}

function safeDecode(token: string): Record<string, unknown> | null {
  try {
    return decodeJwtPayload(token);
  } catch {
    return null;
  }
}

function readNestedString(obj: Record<string, unknown>, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : undefined;
}

function readFirstOrganizationId(obj: Record<string, unknown>): string | undefined {
  const organizations = obj.organizations;
  if (!Array.isArray(organizations)) return undefined;
  for (const organization of organizations) {
    if (!organization || typeof organization !== 'object') continue;
    const id = (organization as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return undefined;
}

function readChatGptAccountId(obj: Record<string, unknown>): string | undefined {
  return (
    readNestedString(obj, ['chatgpt_account_id']) ||
    readNestedString(obj, ['https://api.openai.com/auth', 'chatgpt_account_id']) ||
    readFirstOrganizationId(obj)
  );
}

export function extractAccountClaims(
  accessToken: string,
  idToken?: string,
): CodexAccountClaims {
  const primary = safeDecode(accessToken) ?? {};
  const secondary = idToken ? safeDecode(idToken) ?? {} : {};

  const accountId =
    readChatGptAccountId(secondary) ||
    readChatGptAccountId(primary) ||
    readNestedString(primary, ['sub']) ||
    readNestedString(secondary, ['sub']) ||
    '';

  if (!accountId) {
    throw new Error('Could not find account ID in token');
  }

  const email =
    readNestedString(primary, ['email']) ||
    readNestedString(secondary, ['email']) ||
    readNestedString(primary, ['https://api.openai.com/profile', 'email']) ||
    readNestedString(secondary, ['https://api.openai.com/profile', 'email']);

  const picture =
    readNestedString(secondary, ['picture']) ||
    readNestedString(primary, ['picture']) ||
    readNestedString(secondary, ['https://api.openai.com/profile', 'picture']) ||
    readNestedString(primary, ['https://api.openai.com/profile', 'picture']);

  const plan =
    readNestedString(primary, ['https://api.openai.com/auth', 'chatgpt_plan_type']) ||
    readNestedString(secondary, ['https://api.openai.com/auth', 'chatgpt_plan_type']);

  return { accountId, email, picture, plan };
}

export function safeExtractAccountClaims(
  accessToken: string,
  idToken?: string,
): CodexAccountClaims | null {
  try {
    return extractAccountClaims(accessToken, idToken);
  } catch {
    return null;
  }
}

/**
 * Whether the Codex subscription card is enabled at all in this
 * build. Same opt-out shape as the Claude service.
 */
export function isOpenAiCodexExperimentalEnabled(): boolean {
  return process.env.MAKA_CODEX_SUBSCRIPTION_EXPERIMENTAL !== '0';
}
