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

import {
  redactReversibleStreamingSuffix,
  redactSecrets,
  redactStableStreamingSuffix,
} from './redact.js';

/**
 * Incremental state for display redaction.
 *
 * Secret values cannot cross a line break. Contextual openers may be followed by
 * arbitrary whitespace, though, so an unfinished `Authorization:` or `api_key:`
 * opener and its line are retained until a value or invalidating text arrives.
 * Every earlier complete line is then immutable and may be cached permanently.
 *
 * Assistant/thinking owners configure their existing display cap as the
 * recovery window. Direct oracle-only callers may omit it to retain exact,
 * uncapped semantics for arbitrary inputs.
 */
export interface StreamingDisplayRedactionState {
  /** Safe settled display characters retained by the incremental cache. */
  readonly settledChars: number;
  /** Raw mutable-suffix characters retained privately by this module. */
  readonly pendingChars: number;
}

interface PrivateStreamingDisplayRedactionState {
  readonly settledText: string;
  readonly pendingRaw: string;
  readonly continuationTerminator?: RegExp;
  readonly maxRecoveryChars: number;
  readonly recovery: 'head' | 'tail';
  readonly overflow?: ReversibleOverflow;
}

interface ReversibleOverflow {
  readonly sourceHead: string;
  readonly sourceTail: string;
  readonly compactedToken: string;
  readonly continuationChars: RegExp;
}

export interface StreamingDisplayRedactionOptions {
  /** Existing owner display cap plus one; omit only for uncapped oracle use. */
  readonly maxRecoveryChars?: number;
  readonly recovery?: 'head' | 'tail';
}

const DEFAULT_MAX_RECOVERY_CHARS = Number.POSITIVE_INFINITY;
const STATELESS_REDACTED_TAIL_TERMINATOR = /[\s"'<>&]/;

const PRIVATE_STATE = new WeakMap<
  StreamingDisplayRedactionState,
  PrivateStreamingDisplayRedactionState
>();

export function createStreamingDisplayRedactionState(
  options: StreamingDisplayRedactionOptions = {},
): StreamingDisplayRedactionState {
  return stateFor('', '', undefined, {
    maxRecoveryChars: options.maxRecoveryChars ?? DEFAULT_MAX_RECOVERY_CHARS,
    recovery: options.recovery ?? 'head',
  });
}

export interface StreamingDisplayRedactionResult {
  readonly text: string;
  readonly redacted: boolean;
  readonly state: StreamingDisplayRedactionState;
}

/**
 * Append one raw stream delta while remaining exactly equivalent to applying
 * `redactSecrets` to every complete source prefix.
 *
 * Stream owners must pass the returned `state` on every call for exact
 * differential equivalence. A legacy/direct caller without state is rescanned
 * while its display is lossless; a trailing `<redacted>` marker instead fails
 * closed until a clear terminator because its original source is unavailable.
 */
export function appendStreamingDisplayRedaction(
  previousText: string,
  rawDelta: string,
  state?: StreamingDisplayRedactionState,
): StreamingDisplayRedactionResult {
  const privateState = state === undefined ? undefined : PRIVATE_STATE.get(state);
  const statelessRedactedTail = privateState === undefined && previousText.endsWith('<redacted>');
  const settledText = privateState?.settledText ?? (statelessRedactedTail ? previousText : '');
  const maxRecoveryChars = privateState?.maxRecoveryChars ?? DEFAULT_MAX_RECOVERY_CHARS;
  const recovery = privateState?.recovery ?? 'head';
  let previousPendingRaw = privateState?.pendingRaw ?? (statelessRedactedTail ? '' : previousText);
  let overflow = privateState?.overflow;
  let delta = rawDelta;
  let continuationTerminator = privateState?.continuationTerminator
    ?? (statelessRedactedTail ? STATELESS_REDACTED_TAIL_TERMINATOR : undefined);
  if (continuationTerminator !== undefined) {
    const terminatorIndex = delta.search(continuationTerminator);
    if (terminatorIndex < 0) {
      return {
        text: settledText,
        redacted: delta.length > 0,
        state: stateFor(settledText, '', continuationTerminator, {
          maxRecoveryChars,
          recovery,
        }),
      };
    }
    delta = delta.slice(terminatorIndex);
    continuationTerminator = undefined;
  }

  if (overflow !== undefined) {
    const nextOverflow = {
      sourceHead: (overflow.sourceHead + delta).slice(0, maxRecoveryChars),
      sourceTail: (overflow.sourceTail + delta).slice(-maxRecoveryChars),
      compactedToken: overflow.compactedToken,
      continuationChars: overflow.continuationChars,
    };
    if (reversibleInvalidated(delta, overflow.continuationChars)) {
      previousPendingRaw = recovery === 'head'
        ? overflow.sourceHead + delta
        : overflow.compactedToken + nextOverflow.sourceTail;
      delta = '';
      overflow = undefined;
    } else {
      overflow = nextOverflow;
    }
  }

  const pending = previousPendingRaw + delta;
  const stableSuffix = redactStableStreamingSuffix(pending);
  if (stableSuffix !== undefined) {
    const nextSettledText = settledText + stableSuffix.settledPrefixText;
    return {
      text: settledText + stableSuffix.text,
      redacted: true,
      state: stateFor(nextSettledText, stableSuffix.compactedSuffix, undefined, {
        maxRecoveryChars,
        recovery,
      }),
    };
  }
  const reversibleSuffix = pending.length > maxRecoveryChars
    ? redactReversibleStreamingSuffix(pending)
    : undefined;
  if (reversibleSuffix !== undefined) {
    const nextOverflow = overflow ?? {
      sourceHead: pending.slice(0, maxRecoveryChars),
      sourceTail: pending.slice(-maxRecoveryChars),
      compactedToken: reversibleSuffix.compactedToken,
      continuationChars: reversibleSuffix.continuationChars,
    };
    return {
      text: settledText + redactSecrets(reversibleSuffix.compactedInput),
      redacted: true,
      state: stateFor(settledText, reversibleSuffix.compactedInput, undefined, {
        maxRecoveryChars,
        recovery,
        overflow: nextOverflow,
      }),
    };
  }
  const lastLineBreak = pending.lastIndexOf('\n');
  const pendingContextStart = contextualTail(pending, lastLineBreak)?.start;
  const settlementLineBreak = pendingContextStart === undefined
    ? lastLineBreak
    : pending.lastIndexOf('\n', Math.max(0, pendingContextStart - 1));

  const completedRaw = settlementLineBreak < 0 ? '' : pending.slice(0, settlementLineBreak + 1);
  const pendingRaw = settlementLineBreak < 0 ? pending : pending.slice(settlementLineBreak + 1);
  const redactedCompleted = completedRaw ? redactSecrets(completedRaw) : '';
  const redactedPending = redactSecrets(pendingRaw);
  const nextSettledText = settledText + redactedCompleted;

  return {
    text: nextSettledText + redactedPending,
    redacted:
      redactedCompleted !== completedRaw
      || redactedPending !== pendingRaw,
    state: stateFor(nextSettledText, pendingRaw, undefined, {
      maxRecoveryChars,
      recovery,
    }),
  };
}

function reversibleInvalidated(delta: string, continuationChars: RegExp): boolean {
  for (const character of delta) {
    continuationChars.lastIndex = 0;
    if (continuationChars.test(character)) continue;
    return /\w/.test(character);
  }
  return false;
}

/**
 * Apply the existing per-delta tail cap to an already-safe append. The mutable
 * suffix begins at the first character whose whole-prefix redaction changed;
 * capping that suffix preserves cross-delta masking before discarding bytes.
 */
export function truncateStreamingDisplayAppend(
  previousText: string,
  appended: StreamingDisplayRedactionResult,
  maxDeltaChars: number,
  marker: string,
): StreamingDisplayRedactionResult {
  let mutableStart = 0;
  const commonLength = Math.min(previousText.length, appended.text.length);
  while (
    mutableStart < commonLength
    && previousText.charCodeAt(mutableStart) === appended.text.charCodeAt(mutableStart)
  ) {
    mutableStart += 1;
  }
  const keep = Math.max(0, maxDeltaChars - marker.length);
  const mutableText = appended.text.slice(mutableStart);
  const text = previousText.slice(0, mutableStart)
    + marker
    + mutableText.slice(Math.max(0, mutableText.length - keep));
  const appendedPrivateState = PRIVATE_STATE.get(appended.state);
  return {
    text,
    redacted: appended.redacted,
    state: stateAfterTruncation(text, appendedPrivateState),
  };
}

/** Apply the established thinking tail cap without losing an active secret. */
export function truncateStreamingDisplayTail(
  appended: StreamingDisplayRedactionResult,
  maxTotalChars: number,
  marker: string,
): StreamingDisplayRedactionResult {
  const keep = Math.max(0, maxTotalChars - marker.length);
  const text = marker + appended.text.slice(Math.max(0, appended.text.length - keep));
  const appendedPrivateState = PRIVATE_STATE.get(appended.state);
  return {
    text,
    redacted: appended.redacted,
    state: stateAfterTruncation(text, appendedPrivateState),
  };
}

function stateAfterTruncation(
  text: string,
  privateState: PrivateStreamingDisplayRedactionState | undefined,
): StreamingDisplayRedactionState {
  const pendingRaw = privateState?.pendingRaw ?? '';
  const stableSuffix = redactStableStreamingSuffix(pendingRaw);
  const lastLineBreak = pendingRaw.lastIndexOf('\n');
  const context = contextualTail(pendingRaw, lastLineBreak);
  const contextualRaw = context === undefined ? '' : pendingRaw.slice(context.start);
  const contextualText = redactSecrets(contextualRaw);
  const reversibleRaw = privateState?.overflow?.compactedToken ?? '';
  const reversibleText = redactSecrets(reversibleRaw);
  const canPreserveOverflow = privateState?.overflow !== undefined
    && text.endsWith(reversibleText);
  const canPreserveContext = context !== undefined
    && contextualRaw.length <= (privateState?.maxRecoveryChars ?? DEFAULT_MAX_RECOVERY_CHARS)
    && text.endsWith(contextualText);
  // A tail-capped owner will cap again after the next append, so it can keep a
  // bounded, display-hidden opener and reconstruct the oracle suffix safely.
  const canRecoverHiddenContext = context !== undefined
    && !canPreserveContext
    && privateState?.recovery === 'tail'
    && contextualRaw.length <= privateState.maxRecoveryChars;
  const retainedText = canPreserveOverflow
    ? reversibleText
    : canPreserveContext
      ? contextualText
      : '';
  const retainedRaw = canPreserveOverflow
    ? reversibleRaw
    : canPreserveContext || canRecoverHiddenContext
      ? contextualRaw
      : '';
  const settledText = text.slice(0, text.length - retainedText.length);

  return stateFor(
    settledText,
    retainedRaw,
    privateState?.continuationTerminator
      ?? (canPreserveContext ? undefined : stableSuffix?.terminator)
      ?? (privateState?.overflow === undefined || canPreserveOverflow
        ? undefined
        : /[^A-Za-z0-9_-]/)
      ?? (context === undefined || canPreserveContext || canRecoverHiddenContext
        ? undefined
        : /[\r\n]/),
    {
      ...configFor(privateState),
      ...(canPreserveOverflow ? { overflow: privateState.overflow } : {}),
    },
  );
}

function stateFor(
  settledText: string,
  pendingRaw: string,
  continuationTerminator?: RegExp,
  options: {
    readonly maxRecoveryChars: number;
    readonly recovery: 'head' | 'tail';
    readonly overflow?: ReversibleOverflow;
  } = {
    maxRecoveryChars: DEFAULT_MAX_RECOVERY_CHARS,
    recovery: 'head',
  },
): StreamingDisplayRedactionState {
  const state = Object.freeze({
    settledChars: settledText.length,
    pendingChars: pendingRaw.length
      + (options.overflow?.sourceHead.length ?? 0)
      + (options.overflow?.sourceTail.length ?? 0),
  });
  PRIVATE_STATE.set(state, {
    settledText,
    pendingRaw,
    maxRecoveryChars: options.maxRecoveryChars,
    recovery: options.recovery,
    ...(continuationTerminator === undefined ? {} : { continuationTerminator }),
    ...(options.overflow === undefined ? {} : { overflow: options.overflow }),
  });
  return state;
}

function configFor(
  state: PrivateStreamingDisplayRedactionState | undefined,
): { maxRecoveryChars: number; recovery: 'head' | 'tail' } {
  return {
    maxRecoveryChars: state?.maxRecoveryChars ?? DEFAULT_MAX_RECOVERY_CHARS,
    recovery: state?.recovery ?? 'head',
  };
}

function contextualTail(
  input: string,
  lastLineBreak: number,
): { readonly start: number } | undefined {
  const authorization = /(^|[^A-Za-z0-9_])(authorization)\s*(?:(?:[:=])\s*([A-Za-z]*)(\s*))?$/i.exec(input);
  const apiKey = /(^|[\s"'<>(])((?:x-)?api[-_]?key)\s*(?:[:=]\s*)?$/i.exec(input);
  const query = /[?&](?:access_token|api[_-]?key|apikey|auth|token|secret|signature)=$/i.exec(input);
  const authorizationScheme = authorization?.[3]?.toLowerCase() ?? '';
  const authorizationTrailingSpace = (authorization?.[4]?.length ?? 0) > 0;
  const authorizationPending = authorization !== null
    && ['bearer', 'basic', 'token'].some((scheme) => scheme.startsWith(authorizationScheme))
    && (!authorizationTrailingSpace
      || ['bearer', 'basic', 'token'].includes(authorizationScheme));
  const contexts = [
    ...(authorizationPending && authorization !== null
      ? [{ start: authorization.index }]
      : []),
    ...(apiKey === null ? [] : [{ start: apiKey.index }]),
    ...(query === null ? [] : [{ start: query.index }]),
  ];

  if (lastLineBreak >= 0) {
    const completeContexts = [
      /\b(?:authorization)\s*[:=]\s*(?:bearer|basic|token)\s+[^\s"'<>]+/gi,
      /(^|[\s"'<>(])(?:x-)?api[-_]?key\s*[:=]\s*[^\s"'<>]+/gim,
    ];
    for (const pattern of completeContexts) {
      for (const match of input.matchAll(pattern)) {
        if (match.index < lastLineBreak && match.index + match[0].length > lastLineBreak) {
          contexts.push({ start: match.index });
        }
      }
    }
  }
  return contexts.reduce<ReturnType<typeof contextualTail>>(
    (earliest, context) => earliest === undefined || context.start < earliest.start
      ? context
      : earliest,
    undefined,
  );
}
