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
 * PR-UI-C0 review fixup (@kenji msg 7885a347) — the Anthropic
 * extended-thinking stream the renderer accumulates from
 * `ThinkingDeltaEvent` / `ThinkingCompleteEvent`.
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
 * The pipeline that answers both lives in `stream-delta`, shared with
 * `assistant-stream`; everything below is thinking's own caps, markers, and
 * recovery direction.
 *
 * The renderer stores both the accumulated text AND a per-session
 * monotonic `truncated` flag so the UI can show a "已截断" pill
 * in the `ReasoningPanel` header.
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
 *     cap and the runtime's `TOOL_OUTPUT_DELTA_MAX_CHARS`.
 *   - 32 KB total per session: thinking can run longer than tool
 *     stream (multiple paragraphs of reasoning before the answer),
 *     so 2× A3's per-tool cap. Above this we tail-keep so the
 *     "most recent" reasoning is what the user sees scrolling.
 */
export const THINKING_MAX_DELTA_CHARS = 4 * 1024;
export const THINKING_MAX_TOTAL_CHARS = 32 * 1024;

export interface ApplyThinkingOptions extends ApplyStreamOptions {
  /** Resolved UI locale for user-visible truncation markers. */
  locale?: UiLocale;
}

export type ApplyThinkingResult = ApplyStreamResult;

/** Apply a single `thinking_delta` to the prior accumulated text. */
export function applyThinkingDelta(
  prev: string,
  rawDelta: string,
  options: ApplyThinkingOptions = {},
): ApplyThinkingResult {
  const copy = getSharedUiCopy(options.locale ?? 'zh-CN').stream;
  return applyStreamDelta(prev, rawDelta, {
    maxDeltaChars: options.maxDeltaChars ?? THINKING_MAX_DELTA_CHARS,
    maxTotalChars: options.maxTotalChars ?? THINKING_MAX_TOTAL_CHARS,
    recovery: 'tail',
    chunkMarker: copy.thinkingChunkTruncated,
    totalMarker: copy.thinkingHeadTruncated,
    ...(options.redactionState === undefined
      ? {}
      : { redactionState: options.redactionState }),
  });
}

/**
 * Apply a `thinking_complete` final payload. The provider's
 * `ThinkingCompleteEvent.text` is the FULL final thinking text
 * (not an incremental delta), so we replace rather than append.
 */
export function applyThinkingComplete(
  rawText: string,
  options: ApplyThinkingOptions = {},
): ApplyThinkingResult {
  return applyStreamComplete(rawText, {
    maxTotalChars: options.maxTotalChars ?? THINKING_MAX_TOTAL_CHARS,
    recovery: 'tail',
    totalMarker: getSharedUiCopy(options.locale ?? 'zh-CN').stream.thinkingHeadTruncated,
  });
}
