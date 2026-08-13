import { redactSecrets } from './redact.js';

export const DISPLAY_REDACTION_OVERLAP_CHARS = 512;

export function appendRedactedDisplay(
  previous: string,
  delta: string,
  overlapChars = DISPLAY_REDACTION_OVERLAP_CHARS,
): { text: string; redacted: boolean } {
  const continuation = trimRedactedContinuation(previous, delta);
  const boundary = Math.max(0, previous.length - Math.max(0, overlapChars));
  const stablePrefix = previous.slice(0, boundary);
  const candidate = previous.slice(boundary) + continuation.delta;
  const safeSuffix = redactSecrets(candidate);
  return {
    text: stablePrefix + safeSuffix,
    redacted: continuation.redacted || safeSuffix !== candidate,
  };
}

const REDACTED = '<redacted>';

function trimRedactedContinuation(previous: string, delta: string): {
  delta: string;
  redacted: boolean;
} {
  if (!previous.endsWith(REDACTED) || delta.length === 0) {
    return { delta, redacted: false };
  }
  const context = previous.slice(Math.max(0, previous.length - 256), -REDACTED.length);
  const terminator = /[?&](?:access_token|api[_-]?key|apikey|auth|token|secret|signature)=$/i.test(context)
    ? /[&\s"'<>]/
    : /(?:authorization\s*[:=]\s*(?:bearer|basic|token)\s+|(?:x-)?api[-_]?key:\s*)$/i.test(context)
      ? /[\s"'<>]/
      : /[^A-Za-z0-9_-]/;
  const boundary = delta.search(terminator);
  if (boundary === 0) return { delta, redacted: false };
  if (boundary < 0) return { delta: '', redacted: true };
  return { delta: delta.slice(boundary), redacted: true };
}
