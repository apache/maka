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
 * PR-UI-Cx (@kenji C1 residual note msg aa2d26a7) — pure
 * trust-boundary helper for the assistant `text_delta` stream the
 * renderer accumulates into the active `LiveTurnProjection`.
 *
 * Mirrors A3 `tool-output-stream` / C0 `thinking-stream` exactly:
 *   - pure helper `applyAssistantDelta`
 *   - per-delta cap (defensive against a single misbehaving multi-MB
 *     chunk)
 *   - per-session total cap (bounds renderer state for a runaway
 *     stream)
 *   - secondary `redactSecrets` BEFORE state — the renderer cannot
 *     trust upstream to have masked every secret, and a raw
 *     `Authorization: Bearer …` prefix sitting in the live projection
 *     would expose the secret via React DevTools snapshot, the
 *     "copy message" affordance, and any future serialization that
 *     walks the streaming state.
 *
 * Why "head-keep, mark the tail" instead of "tail-keep, mark the
 * head" for the total cap (different from thinking-stream):
 *
 *   Assistant text is read by the user TOP-DOWN as it streams —
 *   they begin reading the first token immediately and follow the
 *   answer sequentially. Tail-keep would scroll the start of the
 *   answer OFF, which is exactly the wrong shape for "read the
 *   model's reply". Head-keep with a trailing "[…后续已截断]"
 *   marker preserves the visible content the user has been reading
 *   and tells them clearly that more was produced but cut.
 *
 *   Thinking-stream tail-keeps because the user is watching the
 *   CURRENT chain of thought ("what is the model thinking right
 *   now"). Assistant output is the opposite affordance.
 *
 * Per-delta cap stays tail-keep with a head marker — same as
 * thinking — because a single oversize delta is a runtime
 * misbehavior and the user has not been "reading" within that one
 * chunk yet; the chunk is about to be appended atomically.
 */

import { redactSecrets } from './redact.js';
import {
  appendStreamingDisplayRedaction,
  createStreamingDisplayRedactionState,
  truncateStreamingDisplayAppend,
  type StreamingDisplayRedactionState,
} from './streaming-display-redaction.js';
import type { UiLocale } from '@maka/core/ui-locale';
import { getSharedUiCopy } from './shared-ui-copy.js';

/**
 * Default caps. Tuned to:
 *   - 4 KB per single delta: matches A3 tool-output's per-chunk
 *     cap and the runtime's `TOOL_OUTPUT_DELTA_MAX_CHARS`. Streaming
 *     models normally emit ≤ a few hundred chars per delta; a single
 *     4KB+ delta is misbehavior and gets tail-kept.
 *   - 256 KB total per session: a generous bound for ONE assistant
 *     turn. A typical model reply runs 200B-30KB; long-form code +
 *     prose can hit ~80KB; 256KB caps a runaway stream while
 *     leaving 99% of legitimate replies untouched. Past this cap,
 *     further deltas are dropped (the buffer freezes with a
 *     trailing marker; the user sees the head of the answer plus
 *     "[…后续已截断]" — not a silently-truncated mess).
 */
export const ASSISTANT_MAX_DELTA_CHARS = 4 * 1024;
export const ASSISTANT_MAX_TOTAL_CHARS = 256 * 1024;

export interface ApplyAssistantOptions {
  /** Override per-delta cap. */
  maxDeltaChars?: number;
  /** Override per-session total cap. */
  maxTotalChars?: number;
  /** Resolved UI locale for user-visible truncation markers. */
  locale?: UiLocale;
  /** Differential-safe state returned by the preceding delta. */
  redactionState?: StreamingDisplayRedactionState;
}

export interface ApplyAssistantResult {
  /** Resulting accumulated assistant text (post-redaction, post-cap). */
  text: string;
  /** True if redaction modified anything during this call. */
  redacted: boolean;
  /** True if any per-delta or total truncation happened during this call. */
  truncated: boolean;
  /** Bounded state needed to keep later prefixes oracle-equivalent. */
  redactionState?: StreamingDisplayRedactionState;
}

/**
 * Apply a single `text_delta` to the prior accumulated assistant
 * text. Pure: no React state, no DOM, no IPC.
 *
 * Pipeline (in order):
 *   1. Append through the differential-safe redactor. It caches complete
 *      lines and re-runs the whole-text oracle over only the mutable suffix.
 *   2. If the delta alone is oversized, cap the already-redacted mutable
 *      suffix so a cross-delta secret cannot leak through truncation.
 *   3. If the safe-appended exceeds `maxTotalChars`, head-keep
 *      the prefix and append a trailing marker. (User reads the
 *      answer from top; we preserve what they've been reading
 *      and tell them the rest was cut.)
 *
 * Short-circuit: once the buffer is at the total cap (ends with
 * the trailing-truncation marker), subsequent deltas are dropped
 * entirely.
 *
 * The carried state is opaque: live projection stores only a WeakMap key and
 * length counters, never the raw mutable suffix as enumerable React state.
 */
export function applyAssistantDelta(
  prev: string,
  rawDelta: string,
  options: ApplyAssistantOptions = {},
): ApplyAssistantResult {
  const maxDelta = options.maxDeltaChars ?? ASSISTANT_MAX_DELTA_CHARS;
  const maxTotal = options.maxTotalChars ?? ASSISTANT_MAX_TOTAL_CHARS;
  const copy = getSharedUiCopy(options.locale ?? 'zh').stream;
  const truncatedChunkMarker = copy.assistantChunkTruncated;
  const truncatedTailMarker = copy.assistantTailTruncated;

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

  const previousText = prev ?? '';
  // Short-circuit: if the buffer is already capped (ends with the
  // trailing marker AND is at maxTotal), drop further deltas
  // entirely. This avoids reprocessing redaction / cap on a stream
  // of subsequent deltas after the cap has been hit.
  if (
    previousText.length >= maxTotal &&
    previousText.endsWith(truncatedTailMarker)
  ) {
    return { text: previousText, redacted: false, truncated: true };
  }

  const redactionState = options.redactionState ?? appendStreamingDisplayRedaction(
    '',
    previousText,
    createStreamingDisplayRedactionState({
      maxRecoveryChars: maxTotal + 1,
      recovery: 'head',
    }),
  ).state;

  // Oversize deltas keep the established redact-before-truncate behavior. Normal
  // deltas stay raw until the line-aware append below so a later prefix can
  // legitimately make an opaque token visible again.
  const redactedDelta = redactSecrets(rawDelta);
  const perDeltaRedactionHappened = redactedDelta !== rawDelta;

  // L2: per-delta cap. A single oversize delta gets tail-kept with
  // a head marker. (Aligns with C0 thinking-stream; the user hasn't
  // been reading inside the delta atomically.)
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

  // L5: total cap. Head-keep the prefix the user has been reading;
  // mark the tail.
  let result = appended.text;
  let totalTruncated = false;
  if (result.length > maxTotal) {
    const keep = maxTotal - truncatedTailMarker.length;
    result = appended.text.slice(0, keep) + truncatedTailMarker;
    totalTruncated = true;
  }

  return {
    text: result,
    redacted: perDeltaRedactionHappened || appended.redacted,
    truncated: deltaTruncated || totalTruncated,
    ...(totalTruncated
      ? {}
      : { redactionState: appended.state }),
  };
}

/**
 * Apply a `text_complete` final payload. The complete event carries the FULL
 * final assistant text, so this is a replace path: redact and apply only the
 * per-session total cap, not the per-delta cap used for incremental chunks.
 */
export function applyAssistantComplete(
  rawText: string,
  options: Pick<ApplyAssistantOptions, 'maxTotalChars' | 'locale'> = {},
): ApplyAssistantResult {
  const maxTotal = options.maxTotalChars ?? ASSISTANT_MAX_TOTAL_CHARS;
  const truncatedTailMarker = getSharedUiCopy(options.locale ?? 'zh').stream.assistantTailTruncated;

  if (typeof rawText !== 'string') {
    return { text: '', redacted: false, truncated: false };
  }

  const redacted = redactSecrets(rawText);
  const redactionHappened = redacted !== rawText;

  let result = redacted;
  let totalTruncated = false;
  if (result.length > maxTotal) {
    const keep = maxTotal - truncatedTailMarker.length;
    result = redacted.slice(0, keep) + truncatedTailMarker;
    totalTruncated = true;
  }

  return {
    text: result,
    redacted: redactionHappened,
    truncated: totalTruncated,
  };
}
