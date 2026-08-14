import { redactSecrets } from './redact.js';

export const DISPLAY_REDACTION_OVERLAP_CHARS = 512;

export interface IncrementalDisplayRedactionState {
  readonly pendingContext: string;
}

export interface IncrementalDisplayRedactionResult {
  readonly text: string;
  readonly redacted: boolean;
  readonly state?: IncrementalDisplayRedactionState;
}

export interface RedactedIncrementalDisplayDelta {
  readonly text: string;
  readonly redacted: boolean;
  readonly state?: IncrementalDisplayRedactionState;
}

export function redactIncrementalDisplayDelta(
  delta: string,
  state?: IncrementalDisplayRedactionState,
): RedactedIncrementalDisplayDelta {
  const pendingContext = state === undefined
    ? undefined
    : pendingSensitiveContext(state.pendingContext)?.context;
  if (pendingContext === undefined) {
    const text = redactSecrets(delta);
    return { text, redacted: text !== delta, ...stateForText(delta) };
  }
  const contextualInput = pendingContext + delta;
  const contextualOutput = redactSecrets(contextualInput);
  const nextState = stateForText(contextualInput);
  if (contextualOutput === contextualInput) {
    return { text: delta, redacted: false, ...nextState };
  }
  if (!contextualOutput.startsWith(pendingContext)) {
    return { text: '<redacted>', redacted: true };
  }
  return {
    text: contextualOutput.slice(pendingContext.length),
    redacted: true,
    ...nextState,
  };
}

export function appendRedactedDisplay(
  previous: string,
  delta: string,
  state?: IncrementalDisplayRedactionState,
  overlapChars = DISPLAY_REDACTION_OVERLAP_CHARS,
): IncrementalDisplayRedactionResult {
  const continuation = trimRedactedContinuation(previous, delta);
  const pendingContext = state === undefined
    ? undefined
    : pendingSensitiveContext(state.pendingContext)?.context;
  const safeDelta = redactIncrementalDisplayDelta(continuation.delta, state);
  const boundary = Math.max(0, previous.length - Math.max(0, overlapChars));
  const stablePrefix = previous.slice(0, boundary);
  const mutablePrefix = previous.slice(boundary);
  const candidate = mutablePrefix + safeDelta.text;
  const safeSuffix = redactSecrets(candidate);
  const nextContext = pendingSensitiveContext(mutablePrefix + continuation.delta)?.context
    ?? (pendingContext === undefined
      ? undefined
      : pendingSensitiveContext(pendingContext + continuation.delta)?.context);
  return {
    text: stablePrefix + safeSuffix,
    redacted: continuation.redacted || safeDelta.redacted || safeSuffix !== candidate,
    ...(nextContext === undefined ? {} : { state: { pendingContext: nextContext } }),
  };
}

export function incrementalDisplayRedactionStateForText(
  text: string,
): Pick<IncrementalDisplayRedactionResult, 'state'> {
  return stateForText(text);
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

function stateForText(text: string): Pick<IncrementalDisplayRedactionResult, 'state'> {
  const pendingContext = pendingSensitiveContext(text)?.context;
  return pendingContext === undefined ? {} : { state: { pendingContext } };
}

function pendingSensitiveContext(input: string): { context: string; index: number } | undefined {
  const authorization = pendingAuthorizationContext(input);
  const apiKey = pendingApiKeyContext(input);
  if (!authorization) return apiKey;
  if (!apiKey) return authorization;
  return authorization.index > apiKey.index ? authorization : apiKey;
}

function pendingAuthorizationContext(input: string): { context: string; index: number } | undefined {
  const opener = lastMatch(input, /(^|[^A-Za-z0-9_])authorization/gi);
  if (!opener) return undefined;
  const index = opener.index + opener[1]!.length;
  const tail = input.slice(index + 'authorization'.length);
  const parsed = /^(\s*)(?:([:=])(\s*)([A-Za-z]*)(\s*))?$/.exec(tail);
  if (!parsed) return undefined;
  const separator = parsed[2];
  const scheme = parsed[4]?.toLowerCase() ?? '';
  const trailingSpace = (parsed[5]?.length ?? 0) > 0;
  if (separator === undefined) {
    return { context: `Authorization${parsed[1]!.length > 0 ? ' ' : ''}`, index };
  }
  const schemes = ['bearer', 'basic', 'token'];
  if (scheme.length > 0 && !schemes.some((candidate) => candidate.startsWith(scheme))) {
    return undefined;
  }
  if (trailingSpace && !schemes.includes(scheme)) return undefined;
  return {
    context: `Authorization:${scheme.length > 0 ? ` ${scheme}` : ''}${trailingSpace ? ' ' : ''}`,
    index,
  };
}

function pendingApiKeyContext(input: string): { context: string; index: number } | undefined {
  const opener = lastMatch(input, /(^|[\s"'<>(])((?:x-)?api[-_]?key)/gi);
  if (!opener) return undefined;
  const index = opener.index + opener[1]!.length;
  const tail = input.slice(index + opener[2]!.length);
  const parsed = /^(\s*)(?:([:=])(\s*))?$/.exec(tail);
  if (!parsed) return undefined;
  return {
    context: `${opener[2]!.toLowerCase()}${parsed[2] === undefined ? '' : ':'}${
      (parsed[2] === undefined ? parsed[1] : parsed[3])!.length > 0 ? ' ' : ''
    }`,
    index,
  };
}

function lastMatch(input: string, pattern: RegExp): RegExpExecArray | undefined {
  let latest: RegExpExecArray | undefined;
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) latest = match;
  return latest;
}
