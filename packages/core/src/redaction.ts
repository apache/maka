const SECRET_KEY_VALUE_PATTERNS: RegExp[] = [
  /((?:"(?:x-api-key|api-key|api_key|apiKey|access_token|accessToken|auth|authorization|token|password|secret)"\s*:\s*"))(?:\\.|[^"\\])*/gi,
  /\b((?:x-api-key|api-key|api_key|apiKey|access_token|accessToken|token|password|secret)\s*[:=]\s*['"]?)[^\s"'&<>]+/gi,
];

const SECRET_PATTERNS: RegExp[] = [
  /\b(authorization:\s*(?:bearer|basic|token)\s+)[^\s"'<>]+/gi,
  /\b(sk-(?:ant-)?[a-z0-9_-]{8,})\b/gi,
  /\b(AIza[0-9A-Za-z_-]{20,})\b/g,
  /\b(gh[pousr]_[0-9A-Za-z_]{20,})\b/g,
  /\b(xox[abprs]-[0-9A-Za-z-]{10,})\b/g,
  /\b([a-f0-9]{40,})\b/gi,
];

export function redactSecrets(value: string): string {
  let next = redactSerializedJsonSecrets(value);
  next = redactUrlQuerySecrets(next);
  for (const pattern of SECRET_KEY_VALUE_PATTERNS) {
    next = next.replace(pattern, (_match, prefix: string) => `${prefix}[redacted]`);
  }
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, (_match, prefixOrSecret: string) => {
      if (prefixOrSecret.includes(':') || prefixOrSecret.includes('='))
        return `${prefixOrSecret}[redacted]`;
      return '[redacted]';
    });
  }
  return next;
}

function redactSerializedJsonSecrets(value: string): string {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    )
  ) {
    return value;
  }
  try {
    const redacted = redactJsonValue(JSON.parse(value));
    return redacted.changed ? JSON.stringify(redacted.value) : value;
  } catch {
    return value;
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
  if (!value || typeof value !== 'object') return { value, changed: false };

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      next[key] = '[redacted]';
      changed = true;
      continue;
    }
    const redacted = redactJsonValue(raw);
    next[key] = redacted.value;
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

function isSensitiveKey(key: string): boolean {
  return /^(x-api-key|api[_-]?key|key|token|access[_-]?token|auth|authorization|password|secret)$/i.test(
    key,
  );
}

export function generalizedErrorMessage(error: unknown, fallback = 'Operation failed'): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message);
  const lower = redacted.toLowerCase();
  if (lower.includes('timeout')) return 'Request timed out';
  if (lower.includes('429') || lower.includes('rate')) return 'Rate limit exceeded';
  if (lower.includes('401') || lower.includes('403') || lower.includes('auth'))
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
  if (lower.includes('401') || lower.includes('403') || lower.includes('auth')) return '鉴权失败';
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
