export const CODEX_SUBSCRIPTION_USER_AGENT = 'codex_cli_rs/0.0.0 (Maka)';
export const CLAUDE_SUBSCRIPTION_BETA =
  'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219';
export const CLAUDE_SUBSCRIPTION_USER_AGENT = 'claude-cli/2.1.153 (external, cli)';

export function claudeSubscriptionHeaders(): Record<string, string> {
  return {
    'User-Agent': CLAUDE_SUBSCRIPTION_USER_AGENT,
    'anthropic-beta': CLAUDE_SUBSCRIPTION_BETA,
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
  };
}

export function openAiCodexHeaders(accessToken: string): Record<string, string> {
  const accountId = extractCodexAccountId(accessToken);
  return {
    ...(accountId
      ? {
          'ChatGPT-Account-Id': accountId,
        }
      : {}),
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    'User-Agent': CODEX_SUBSCRIPTION_USER_AGENT,
  };
}

/**
 * Extract the ChatGPT account id for request-header routing. Deliberately
 * does NOT fall back to the JWT `sub` claim: the account id must come from
 * the OpenAI-specific account/organization claims (a `sub` is not a
 * ChatGPT account id and must not be sent as ChatGPT-Account-Id).
 */
export function extractCodexAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;
  return readChatGptAccountId(payload) ?? null;
}

export interface CodexAccountClaims {
  accountId: string;
  email?: string;
  picture?: string;
  plan?: string;
}

/**
 * Extract the ChatGPT account identity + profile claims from the Codex
 * access token (and optional id_token). Single authority for both the
 * request-header account routing and the desktop account-state snapshot.
 * Returns null when no account id can be determined.
 */
export function extractCodexAccountClaims(
  accessToken: string,
  idToken?: string,
): CodexAccountClaims | null {
  const primary = decodeJwtPayload(accessToken);
  const secondary = idToken ? decodeJwtPayload(idToken) : null;
  if (!primary && !secondary) return null;
  const p = primary ?? {};
  const s = secondary ?? {};

  const accountId =
    readChatGptAccountId(s) ||
    readChatGptAccountId(p) ||
    readNestedString(p, ['sub']) ||
    readNestedString(s, ['sub']);
  if (!accountId) return null;

  const email =
    readNestedString(p, ['email']) ||
    readNestedString(s, ['email']) ||
    readNestedString(p, ['https://api.openai.com/profile', 'email']) ||
    readNestedString(s, ['https://api.openai.com/profile', 'email']);
  const picture =
    readNestedString(s, ['picture']) ||
    readNestedString(p, ['picture']) ||
    readNestedString(s, ['https://api.openai.com/profile', 'picture']) ||
    readNestedString(p, ['https://api.openai.com/profile', 'picture']);
  const plan =
    readNestedString(p, ['https://api.openai.com/auth', 'chatgpt_plan_type']) ||
    readNestedString(s, ['https://api.openai.com/auth', 'chatgpt_plan_type']);

  return {
    accountId,
    ...(email !== undefined ? { email } : {}),
    ...(picture !== undefined ? { picture } : {}),
    ...(plan !== undefined ? { plan } : {}),
  };
}

/**
 * Renderer-safe account label for the OpenAI OAuth profile list. The raw
 * email is JWT-derived identity data, so it is intentionally masked before it
 * crosses the Host boundary; the masked form is still enough to distinguish
 * two accounts without exposing the full address.
 */
export function codexAccountHint(claims: CodexAccountClaims | null): string | undefined {
  const email = claims?.email?.trim();
  if (email !== undefined && email.length > 0 && email.includes('@')) {
    return limitAccountHint(maskCodexEmail(email));
  }
  const accountId = claims?.accountId?.trim();
  if (accountId !== undefined && accountId.length > 0) {
    return limitAccountHint(maskOpaqueIdentifier(accountId));
  }
  return undefined;
}

function limitAccountHint(hint: string): string {
  return hint.length > 256 ? hint.slice(0, 256) : hint;
}

function maskCodexEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return maskOpaqueIdentifier(email);
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length <= 2) {
    return `${local[0] ?? '*'}***@${domain}`;
  }
  const headLength = Math.max(1, Math.floor(local.length / 3));
  const tailLength = Math.max(1, Math.floor(local.length / 4));
  const stars = Math.max(3, local.length - headLength - tailLength);
  return `${local.slice(0, headLength)}${'*'.repeat(stars)}${local.slice(
    local.length - tailLength,
  )}@${domain}`;
}

function maskOpaqueIdentifier(identifier: string): string {
  if (identifier.length <= 6) return `${identifier.slice(0, 2)}***`;
  return `${identifier.slice(0, 3)}****${identifier.slice(-4)}`;
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

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
