/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

export const CODEX_SUBSCRIPTION_USER_AGENT = 'codex_cli_rs/0.0.0 (Maka)';
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
