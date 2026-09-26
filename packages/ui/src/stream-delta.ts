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
 * The one trust-boundary pipeline the renderer runs over a streamed text
 * buffer, shared by `assistant-stream` and `thinking-stream`. Both streams
 * append provider text into a live `LiveTurnProjection` field, and both need
 * the same two guarantees before that text becomes React state:
 *
 *   - `redactSecrets` BEFORE state — a raw `Authorization: Bearer …` prefix
 *     sitting in the live projection would leak through a React DevTools
 *     snapshot, the "copy message" affordance, and any future serialization
 *     that walks the streaming state;
 *   - a per-session total cap that bounds renderer state for a runaway stream.
 *
 * Delta boundaries are Runtime Host transport slices (merged under
 * backpressure, paid out as backlog, or a whole reconnect seed), so nothing
 * here keys on the size of a single delta.
 *
 * The streams differ only in their caps, their user-visible markers, and which
 * end of an over-cap buffer survives — the `recovery` direction
 * `streaming-display-redaction` already parameterizes:
 *
 *   `recovery: 'head'` (assistant text) keeps the prefix and marks the tail.
 *   Assistant output is read TOP-DOWN as it streams; tail-keep would scroll
 *   the start of the answer off, which is the wrong shape for "read the
 *   model's reply". Head-keep also freezes the buffer once it is full, so
 *   later deltas short-circuit rather than reprocess.
 *
 *   `recovery: 'tail'` (thinking) keeps the most recent text and marks the
 *   head. The user watching extended thinking is following the CURRENT chain
 *   of thought, so the oldest reasoning is the least relevant.
 *
 * `tool-output-stream` is deliberately not folded in here — it accumulates an
 * array of chunks with dedup-by-seq, which is a different problem.
 */

import { redactSecrets } from './redact.js';
import {
  appendStreamingDisplayRedaction,
  copyStreamingDisplayRedactionState,
  createStreamingDisplayRedactionState,
  truncateStreamingDisplayTail,
  type StreamingDisplayRedactionState,
} from './streaming-display-redaction.js';

/** Caller-facing knobs, identical for both streams. */
export interface ApplyStreamOptions {
  /** Override per-session total cap. */
  maxTotalChars?: number;
  /** Differential-safe state returned by the preceding delta. */
  redactionState?: StreamingDisplayRedactionState;
}

export interface ApplyStreamResult {
  /** Resulting accumulated text (post-redaction, post-cap). */
  text: string;
  /** True if the total cap cut text during this call. */
  truncated: boolean;
  /** Bounded state needed to keep later prefixes oracle-equivalent. */
  redactionState?: StreamingDisplayRedactionState;
}

/** Everything a concrete stream resolves before the shared pipeline runs. */
export interface StreamDeltaSpec {
  maxTotalChars: number;
  /** Which end of an over-cap buffer survives. */
  recovery: 'head' | 'tail';
  /** Marker for the total cap: appended for 'head', prepended for 'tail'. */
  totalMarker: string;
  redactionState?: StreamingDisplayRedactionState;
}

/** The `complete` path replaces rather than appends, so it needs less. */
export type StreamCompleteSpec = Omit<StreamDeltaSpec, 'redactionState'>;

/**
 * Apply a single delta to the prior accumulated text. Pure: no React state,
 * no DOM, no IPC.
 *
 * Pipeline (in order):
 *   1. Append through the differential-safe redactor. It caches complete
 *      lines and re-runs the whole-text oracle over only the mutable suffix.
 *   2. If the result exceeds `maxTotalChars`, cut the end `recovery` names.
 *
 * The carried state is opaque: the live projection stores only a WeakMap key
 * and length counters, never the raw mutable suffix as enumerable React state.
 */
export function applyStreamDelta(
  prev: string,
  rawDelta: string,
  spec: StreamDeltaSpec,
): ApplyStreamResult {
  const { maxTotalChars, recovery, totalMarker } = spec;
  const previousText = prev ?? '';

  // Defensive guard: a non-string delta is a runtime contract violation. Drop
  // it silently rather than coerce it.
  if (typeof rawDelta !== 'string') {
    return {
      text: previousText,
      truncated: false,
      ...(spec.redactionState === undefined
        ? {}
        : { redactionState: spec.redactionState }),
    };
  }

  // Short-circuit: head-keep freezes the buffer once it is full, so a stream
  // of subsequent deltas would redact and re-cap toward the same result.
  // Tail-keep has no such fixed point — the window keeps sliding.
  if (
    recovery === 'head' &&
    previousText.length >= maxTotalChars &&
    previousText.endsWith(totalMarker)
  ) {
    return { text: previousText, truncated: true };
  }

  const redactionState = spec.redactionState ?? appendStreamingDisplayRedaction(
    '',
    previousText,
    createStreamingDisplayRedactionState({
      maxRecoveryChars: maxTotalChars + 1,
      recovery,
    }),
  ).state;

  const appended = appendStreamingDisplayRedaction(
    previousText,
    rawDelta,
    redactionState,
  );

  let result = appended.text;
  let capped = appended;
  let truncated = false;
  if (result.length > maxTotalChars) {
    truncated = true;
    if (recovery === 'head') {
      result = result.slice(0, maxTotalChars - totalMarker.length) + totalMarker;
    } else {
      capped = truncateStreamingDisplayTail(appended, maxTotalChars, totalMarker);
      result = capped.text;
    }
  }

  // A reconnect seed can carry the full stream in one delta. When less of it
  // survives than arrived, copy the bounded display and recovery state so
  // their slices cannot keep that payload alive.
  if (rawDelta.length > result.length) {
    result = structuredClone(result);
    if (!(recovery === 'head' && truncated)) {
      capped = { ...capped, state: copyStreamingDisplayRedactionState(capped.state) };
    }
  }

  return {
    text: result,
    truncated,
    // A head-keep cut drops the mutable suffix the state describes, so there
    // is nothing left to carry; every other path hands the state forward.
    ...(recovery === 'head' && truncated
      ? {}
      : { redactionState: capped.state }),
  };
}

/**
 * Apply a `complete` final payload. The complete event carries the FULL final
 * text, so this is a replace path: redact, then apply the total cap.
 */
export function applyStreamComplete(
  rawText: string,
  spec: StreamCompleteSpec,
): ApplyStreamResult {
  const { maxTotalChars, recovery, totalMarker } = spec;

  if (typeof rawText !== 'string') {
    return { text: '', truncated: false };
  }

  let result = redactSecrets(rawText);
  let truncated = false;
  if (result.length > maxTotalChars) {
    const keep = maxTotalChars - totalMarker.length;
    result = recovery === 'head'
      ? result.slice(0, keep) + totalMarker
      : totalMarker + result.slice(result.length - keep);
    truncated = true;
  }

  return {
    // Detach the bounded display from a slice's potentially much larger backing string.
    text: truncated ? structuredClone(result) : result,
    truncated,
  };
}
