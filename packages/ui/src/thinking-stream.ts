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

/**
 * PR-UI-C0 review fixup (@kenji msg 7885a347) — pure trust-boundary
 * helper for the Anthropic extended-thinking stream the renderer
 * accumulates from `ThinkingDeltaEvent` / `ThinkingCompleteEvent`.
 *
 * The original C0 implementation appended `event.text` directly
 * into the live-turn projection and rendered with
 * `<pre>{thinkingText}</pre>` — no Markdown, no redaction, no size
 * cap. Two trust-boundary failures: (1) model thinking output can
 * echo prompts / env / tool stderr / pasted credentials, so the
 * raw text must NOT enter React state without secondary
 * `redactSecrets`; (2) extended thinking can stream tens or
 * hundreds of KB, and `<pre>` `max-height: 320px` only bounds
 * VISUAL height, not the DOM text length / React state / DevTools
 * snapshot.
 *
 * This module mirrors the A3 `tool-output-stream` shape exactly:
 *   - pure helpers `applyThinkingDelta` / `applyThinkingComplete`
 *   - per-chunk cap (tail-keep with marker)
 *   - per-session total cap (tail-keep — thinking is sequential;
 *     oldest is least relevant for the user observing live
 *     reasoning)
 *   - secondary `redactSecrets` BEFORE state, with `redacted`
 *     monotonic (upstream claim survives; renderer can only
 *     escalate)
 *
 * The renderer stores both the accumulated text AND a per-session
 * monotonic `truncated` flag so the UI can show a "已截断" pill
 * in the `ReasoningPanel` header.
 */

import { redactSecrets } from './redact.js';
import {
  appendStreamingDisplayRedaction,
  createStreamingDisplayRedactionState,
  truncateStreamingDisplayAppend,
  truncateStreamingDisplayTail,
  type StreamingDisplayRedactionState,
} from './streaming-display-redaction.js';
import type { UiLocale } from '@maka/core/ui-locale';
import { getSharedUiCopy } from './shared-ui-copy.js';

/**
 * Default caps. Tuned to:
 *   - 4 KB per single delta: matches A3 tool-output's per-chunk
 *     cap and the runtime's `TOOL_OUTPUT_DELTA_MAX_CHARS`.
 *   - 32 KB total per session: thinking can run longer than tool
 *     stream (multiple paragraphs of reasoning before the answer),
 *     so 2× A3's per-tool cap. Above this we tail-keep so the
 *     "most recent" reasoning is what the user sees scrolling.
 */
export const THINKING_MAX_DELTA_CHARS = 4 * 1024;
export const THINKING_MAX_TOTAL_CHARS = 32 * 1024;

export interface ApplyThinkingOptions {
  /** Override per-delta cap. */
  maxDeltaChars?: number;
  /** Override per-session total cap. */
  maxTotalChars?: number;
  /** Resolved UI locale for user-visible truncation markers. */
  locale?: UiLocale;
  /** Differential-safe state returned by the preceding delta. */
  redactionState?: StreamingDisplayRedactionState;
}

export interface ApplyThinkingResult {
  /** Resulting accumulated thinking text (post-redaction, post-cap). */
  text: string;
  /** True if any redaction happened during this call. */
  redacted: boolean;
  /** True if any drop / truncation happened during this call. */
  truncated: boolean;
  /** Bounded state needed to keep later prefixes oracle-equivalent. */
  redactionState?: StreamingDisplayRedactionState;
}

/**
 * Apply a single `thinking_delta` to the prior accumulated text.
 * Pure: no React state, no DOM, no IPC.
 *
 *   1. Append through the differential-safe line/suffix redactor.
 *   2. If the delta alone is oversized, cap the already-safe mutable suffix.
 *   3. If the result exceeds `maxTotalChars`, tail-keep the most
 *      recent `maxTotalChars` characters with a head marker.
 *      Thinking is sequential reasoning; the user is looking at
 *      the CURRENT chain of thought, not the start.
 */
export function applyThinkingDelta(
  prev: string,
  rawDelta: string,
  options: ApplyThinkingOptions = {},
): ApplyThinkingResult {
  const maxDelta = options.maxDeltaChars ?? THINKING_MAX_DELTA_CHARS;
  const maxTotal = options.maxTotalChars ?? THINKING_MAX_TOTAL_CHARS;
  const copy = getSharedUiCopy(options.locale ?? 'zh').stream;
  const truncatedHeadMarker = copy.thinkingHeadTruncated;
  const truncatedChunkMarker = copy.thinkingChunkTruncated;
  const previousText = prev ?? '';

  // Defensive guard: a non-string `rawDelta` is a runtime contract
  // violation. Drop it silently rather than coerce to '' and claim
  // redaction happened.
  if (typeof rawDelta !== 'string') {
    return {
      text: prev ?? '',
      redacted: false,
      truncated: false,
      ...(options.redactionState === undefined
        ? {}
        : { redactionState: options.redactionState }),
    };
  }

  const redactionState = options.redactionState ?? appendStreamingDisplayRedaction(
    '',
    previousText,
    createStreamingDisplayRedactionState({
      maxRecoveryChars: maxTotal + 1,
      recovery: 'tail',
    }),
  ).state;

  // Oversize deltas retain redact-before-truncate. Normal deltas remain raw
  // until the line-aware append so every streamed prefix can match the oracle.
  const redactedDelta = redactSecrets(rawDelta);
  const redactionHappened = redactedDelta !== rawDelta;

  // L2: per-delta cap. Tail-keep with marker prepended.
  let deltaTruncated = false;
  const rawAppended = appendStreamingDisplayRedaction(
    previousText,
    rawDelta,
    redactionState,
  );
  const appended = redactedDelta.length > maxDelta
    ? truncateStreamingDisplayAppend(
        previousText,
        rawAppended,
        maxDelta,
        truncatedChunkMarker,
      )
    : rawAppended;
  deltaTruncated = appended !== rawAppended;

  // L4: per-session total cap. Tail-keep most recent.
  let result = appended.text;
  let totalTruncated = false;
  let capped = appended;
  if (result.length > maxTotal) {
    capped = truncateStreamingDisplayTail(appended, maxTotal, truncatedHeadMarker);
    result = capped.text;
    totalTruncated = true;
  }

  return {
    text: result,
    redacted: redactionHappened || appended.redacted,
    truncated: deltaTruncated || totalTruncated,
    redactionState: capped.state,
  };
}

/**
 * Apply a `thinking_complete` final payload. The provider's
 * `ThinkingCompleteEvent.text` is the FULL final thinking text
 * (not an incremental delta), so we replace rather than append.
 * The same redaction + size cap rules apply.
 */
export function applyThinkingComplete(
  rawText: string,
  options: ApplyThinkingOptions = {},
): ApplyThinkingResult {
  const maxTotal = options.maxTotalChars ?? THINKING_MAX_TOTAL_CHARS;
  const truncatedHeadMarker = getSharedUiCopy(options.locale ?? 'zh').stream.thinkingHeadTruncated;

  // Same defensive guard as `applyThinkingDelta`.
  if (typeof rawText !== 'string') {
    return { text: '', redacted: false, truncated: false };
  }

  // L1: secondary redaction.
  const redacted = redactSecrets(rawText);
  const redactionHappened = redacted !== rawText;

  // L2: total cap. Tail-keep most recent reasoning.
  let result = redacted;
  let totalTruncated = false;
  if (result.length > maxTotal) {
    const keep = maxTotal - truncatedHeadMarker.length;
    result = truncatedHeadMarker + result.slice(result.length - keep);
    totalTruncated = true;
  }

  return {
    text: result,
    redacted: redactionHappened,
    truncated: totalTruncated,
  };
}
