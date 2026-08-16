import { redactSecrets } from '@maka/core/redaction';

export const MCP_IDENTITY_DIAGNOSTIC_CODE_POINTS = 80;
export const MCP_ERROR_DIAGNOSTIC_CODE_POINTS = 2_000;
export const MCP_DIAGNOSTIC_INPUT_CODE_UNITS = 8_192;
const OVERSIZED_MCP_DIAGNOSTIC = '[MCP diagnostic omitted: input exceeded limit]';

/** Render untrusted MCP text without control spoofing, secrets, or unbounded output. */
export function formatMcpDiagnosticText(
  value: string,
  maxCodePoints = MCP_IDENTITY_DIAGNOSTIC_CODE_POINTS,
): string {
  const outputLimit = normalizeOutputLimit(maxCodePoints);
  if (value.length > MCP_DIAGNOSTIC_INPUT_CODE_UNITS) {
    return [...OVERSIZED_MCP_DIAGNOSTIC].slice(0, outputLimit).join('');
  }
  const redacted = redactSecrets(value);
  const sanitized = redacted.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '\uFFFD');
  const codePoints = [...sanitized];
  if (codePoints.length <= outputLimit) return sanitized;
  return `${codePoints.slice(0, outputLimit - 1).join('')}\u2026`;
}

function normalizeOutputLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return MCP_IDENTITY_DIAGNOSTIC_CODE_POINTS;
  }
  return Math.min(value, MCP_ERROR_DIAGNOSTIC_CODE_POINTS);
}
