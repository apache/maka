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
 * PR-UI-Cx (@kenji C1 residual note msg aa2d26a7) — the assistant
 * `text_delta` stream the renderer accumulates into the active
 * `LiveTurnProjection`.
 *
 * The pipeline itself lives in `stream-delta`, which this module and
 * `thinking-stream` share; everything below is the assistant's own caps,
 * markers, and recovery direction. Assistant text head-keeps because the user
 * reads a reply top-down — see `stream-delta` for why thinking does not.
 */

import type { UiLocale } from '@maka/core/ui-locale';
import { getSharedUiCopy } from './shared-ui-copy.js';
import {
  applyStreamComplete,
  applyStreamDelta,
  type ApplyStreamOptions,
  type ApplyStreamResult,
} from './stream-delta.js';

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

export interface ApplyAssistantOptions extends ApplyStreamOptions {
  /** Resolved UI locale for user-visible truncation markers. */
  locale?: UiLocale;
}

export type ApplyAssistantResult = ApplyStreamResult;

/** Apply a single `text_delta` to the prior accumulated assistant text. */
export function applyAssistantDelta(
  prev: string,
  rawDelta: string,
  options: ApplyAssistantOptions = {},
): ApplyAssistantResult {
  const copy = getSharedUiCopy(options.locale ?? 'zh-CN').stream;
  return applyStreamDelta(prev, rawDelta, {
    maxDeltaChars: options.maxDeltaChars ?? ASSISTANT_MAX_DELTA_CHARS,
    maxTotalChars: options.maxTotalChars ?? ASSISTANT_MAX_TOTAL_CHARS,
    recovery: 'head',
    chunkMarker: copy.assistantChunkTruncated,
    totalMarker: copy.assistantTailTruncated,
    ...(options.redactionState === undefined
      ? {}
      : { redactionState: options.redactionState }),
  });
}

/** Apply a `text_complete` final payload (replace, total cap only). */
export function applyAssistantComplete(
  rawText: string,
  options: Pick<ApplyAssistantOptions, 'maxTotalChars' | 'locale'> = {},
): ApplyAssistantResult {
  return applyStreamComplete(rawText, {
    maxTotalChars: options.maxTotalChars ?? ASSISTANT_MAX_TOTAL_CHARS,
    recovery: 'head',
    totalMarker: getSharedUiCopy(options.locale ?? 'zh-CN').stream.assistantTailTruncated,
  });
}
