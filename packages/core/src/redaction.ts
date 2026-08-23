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

const SENSITIVE_KEY_SUFFIXES = new Set([
  'auth',
  'authorization',
  'credential',
  'credentials',
  'passwd',
  'password',
  'secret',
  'token',
]);
const SENSITIVE_KEY_QUALIFIERS = new Set(['api', 'private', 'secret', 'ssh']);

const POSIX_LINE_CONTINUATION_SOURCE = String.raw`\\\r?\n`;
const OPTIONAL_POSIX_LINE_CONTINUATION_SOURCE = `(?:${POSIX_LINE_CONTINUATION_SOURCE})*`;
const SHELL_SEPARATOR_SOURCE = `(?:[ \\t]|${POSIX_LINE_CONTINUATION_SOURCE})+`;
const OPTIONAL_SHELL_SEPARATOR_SOURCE = `(?:[ \\t]|${POSIX_LINE_CONTINUATION_SOURCE})*`;
const SHELL_SECRET_TOKEN_SOURCE = `("(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|(?:${POSIX_LINE_CONTINUATION_SOURCE}|[^\\s;&|()<>])+)`;

const AWS_CONFIG_SECRET_KEY_SOURCE = posixContinuedTokenSource('aws_secret_access_key');
const AWS_SECRET_ACCESS_KEY_FLAG_SOURCE = posixContinuedTokenSource('--secret-access-key');
const AWS_SECRET_ACCESS_KEY_ENV_SOURCE = posixContinuedTokenSource('AWS_SECRET_ACCESS_KEY');

const QUOTED_SECRET_KEY_VALUE_PATTERN = /((?:"([^"\\]+)"\s*:\s*"))(?:\\.|[^"\\])*/g;
const ASSIGNED_SECRET_KEY_VALUE_PATTERN =
  /\b(([A-Za-z][A-Za-z0-9_-]*)(?:[ \t]|\\\r?\n)*[:=](?:[ \t]|\\\r?\n)*['"]?)(?:\\\r?\n|[^\s"'&<>])+/g;
const AUTHORIZATION_HEADER_PATTERN =
  /(^|[^A-Za-z0-9_])(['"]?(?:proxy[-_]?authorization|authorization)['"]?\s*:\s*['"]?(?:bearer|basic|token)\s+)[^\s"'<>]+/gim;
const AWS_CLI_SPACE_SECRET_PATTERN = new RegExp(
  `(^|[\\s;&|()])((?:aws${SHELL_SEPARATOR_SOURCE}configure${SHELL_SEPARATOR_SOURCE}set${SHELL_SEPARATOR_SOURCE}${AWS_CONFIG_SECRET_KEY_SOURCE}|${AWS_SECRET_ACCESS_KEY_FLAG_SOURCE})${SHELL_SEPARATOR_SOURCE})${SHELL_SECRET_TOKEN_SOURCE}`,
  'gm',
);
const AWS_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${AWS_SECRET_ACCESS_KEY_ENV_SOURCE}${OPTIONAL_SHELL_SEPARATOR_SOURCE}[:=]${OPTIONAL_SHELL_SEPARATOR_SOURCE}['"]?)(?:${POSIX_LINE_CONTINUATION_SOURCE}|[^\\s"'&<>])+`,
  'gi',
);

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-(?:ant-)?[a-z0-9_-]{8,})\b/gi,
  /\b(AIza[0-9A-Za-z_-]{20,})\b/g,
  /\b(gh[pousr]_[0-9A-Za-z_]{20,})\b/g,
  /\b(xox[abprs]-[0-9A-Za-z-]{10,})\b/g,
  /\b([a-f0-9]{40,})\b/gi,
];

export function redactSecrets(value: string): string {
  const json = redactSerializedJsonSecrets(value);
  return json ?? redactTextSecrets(value);
}

function redactTextSecrets(value: string): string {
  let next = value;
  next = redactUrlQuerySecrets(next);
  next = next.replace(QUOTED_SECRET_KEY_VALUE_PATTERN, (match, prefix: string, key: string) =>
    isSensitiveKey(key) ? `${prefix}[redacted]` : match,
  );
  next = next.replace(
    AUTHORIZATION_HEADER_PATTERN,
    (_match, boundary: string, prefix: string) => `${boundary}${prefix}[redacted]`,
  );
  next = next.replace(
    AWS_CLI_SPACE_SECRET_PATTERN,
    (_match, boundary: string, prefix: string, token: string) =>
      `${boundary}${prefix}${redactShellToken(token)}`,
  );
  next = next.replace(
    AWS_SECRET_ASSIGNMENT_PATTERN,
    (_match, prefix: string) => `${prefix}[redacted]`,
  );
  next = next.replace(ASSIGNED_SECRET_KEY_VALUE_PATTERN, (match, prefix: string, key: string) =>
    isAssignmentSensitiveKey(key) ? `${prefix}[redacted]` : match,
  );
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, (_match, prefixOrSecret: string) => {
      if (prefixOrSecret.includes(':') || prefixOrSecret.includes('='))
        return `${prefixOrSecret}[redacted]`;
      return '[redacted]';
    });
  }
  return next;
}

function posixContinuedTokenSource(token: string): string {
  return [...token]
    .map((character) => escapeRegExpLiteral(character))
    .join(OPTIONAL_POSIX_LINE_CONTINUATION_SOURCE);
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function redactShellToken(token: string): string {
  const quote = token.at(0);
  return (quote === '"' || quote === "'") && token.at(-1) === quote
    ? `${quote}[redacted]${quote}`
    : '[redacted]';
}

function redactSerializedJsonSecrets(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'string' && (parsed === null || typeof parsed !== 'object'))
      return undefined;
    const redacted = redactJsonValue(parsed);
    return redacted.changed ? JSON.stringify(redacted.value) : value;
  } catch {
    return undefined;
  }
}

function redactJsonValue(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactJsonValue(item);
      changed = changed || redacted.changed;
      return redacted.value;
    });
    return { value: next, changed };
  }
  if (typeof value === 'string') {
    const next = redactTextSecrets(value);
    return { value: next, changed: next !== value };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      Object.defineProperty(next, key, {
        value: '[redacted]',
        enumerable: true,
        configurable: true,
        writable: true,
      });
      changed = true;
      continue;
    }
    const redacted = redactJsonValue(raw);
    Object.defineProperty(next, key, {
      value: redacted.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    changed = changed || redacted.changed;
  }
  return { value: next, changed };
}

function redactUrlQuerySecrets(value: string): string {
  return value.replace(/([?&])([^=\s&?#]+)=([^&\s#]*)/g, (match, sep: string, key: string) => {
    if (!isSensitiveKey(key)) return match;
    return `${sep}${key}=[redacted]`;
  });
}

/** Whether a key NAME marks its value as credential material (TOKEN,
 * API_KEY, clientSecret, …). Exported for callers that must decide whether
 * a keyed value is a secret — e.g. which MCP stdio env values are masked at
 * the IPC boundary — so the heuristic cannot drift from the one redaction
 * itself applies. */
export function isSensitiveKey(key: string): boolean {
  const segments = sensitiveKeySegments(key);
  const suffix = segments.at(-1);
  if (!suffix) return false;
  if (suffix !== 'key') return SENSITIVE_KEY_SUFFIXES.has(suffix);
  if (segments.length === 1) return true;
  if (SENSITIVE_KEY_QUALIFIERS.has(segments.at(-2) ?? '')) return true;
  const qualifiedKey = segments.slice(-3).join('_');
  return qualifiedKey === 'service_account_key' || qualifiedKey === 'secret_access_key';
}

function sensitiveKeySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isAssignmentSensitiveKey(key: string): boolean {
  if (!isSensitiveKey(key)) return false;
  const suffix = sensitiveKeySegments(key).at(-1);
  return suffix !== 'auth' && suffix !== 'authorization';
}

export function generalizedErrorMessage(error: unknown, fallback = 'Operation failed'): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message);
  const lower = redacted.toLowerCase();
  if (lower.includes('timeout')) return 'Request timed out';
  if (lower.includes('429') || lower.includes('rate')) return 'Rate limit exceeded';
  if (lower.includes('401') || lower.includes('403') || isAuthenticationErrorText(lower))
    return 'Authentication failed';
  if (lower.includes('5') && /\b5\d\d\b/.test(lower)) return 'Provider returned an error';
  if (
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('econn') ||
    lower.includes('enotfound')
  )
    return 'Network error';
  return fallback;
}

/**
 * Chinese-locale companion to `generalizedErrorMessage()` (PR110b
 * follow-up). Same classification rules; returns Chinese phrasing
 * instead of English. Used by surfaces that must enforce a
 * Chinese-only error copy contract (session start, onboarding setup
 * banners, etc.) — the English version would have leaked through any
 * matched category, breaking the gate.
 *
 * The fallback default is also Chinese so callers that don't supply
 * one still produce a Chinese-only result. Pass a more specific
 * Chinese fallback (e.g. "会话已创建但发送失败，请重试。") for better
 * UX when the classifier can't categorize.
 */
export function generalizedErrorMessageChinese(error: unknown, fallback = '操作失败'): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message);
  const lower = redacted.toLowerCase();
  if (lower.includes('timeout')) return '请求超时';
  if (lower.includes('429') || lower.includes('rate')) return '触发模型速率限制';
  if (lower.includes('401') || lower.includes('403') || isAuthenticationErrorText(lower))
    return '鉴权失败';
  if (lower.includes('5') && /\b5\d\d\b/.test(lower)) return '模型服务返回错误';
  if (
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('econn') ||
    lower.includes('enotfound')
  )
    return '网络错误';
  return fallback;
}

export function isAuthenticationErrorText(message: string): boolean {
  return message.replace(/\bauthorit\w*/g, '').includes('auth');
}
