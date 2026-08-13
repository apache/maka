/**
 * PR-UI-12 review fixup #2 (@kenji A3 review msg 365ff8b9).
 *
 * Pure helper for accepting a single `tool_output_delta` chunk into
 * the running `outputChunks: ToolOutputChunk[]` array. Three concerns
 * the renderer was previously trusting main-side to handle, now
 * enforced on the renderer side too as defense in depth:
 *
 *   1. **Secondary redaction**: every incoming chunk's `text` is
 *      run through the shared `redactSecrets` helper BEFORE the
 *      chunk lands in React state. The renderer cannot trust the
 *      main-side runtime to have masked every secret — tool stderr
 *      / provider error bodies sometimes leak credentials past the
 *      runtime tail-window redactor, and a streaming path that
 *      stored raw text would expose the secret in:
 *        - React state snapshots (DevTools, Redux-style time-travel)
 *        - the "copy chunk" affordance
 *        - any future serialization that walks `outputChunks`.
 *      If redaction changes the text, the resulting chunk's
 *      `redacted` flag is forced to `true` so the UI shows the
 *      "[已脱敏]" hint regardless of what the upstream event
 *      claimed.
 *
 *   2. **Per-chunk cap**: a single chunk whose `text.length` exceeds
 *      `maxChunkChars` is truncated and tail-padded with a clear
 *      marker. The runtime's tool output tailing should usually
 *      prevent this, but a misbehaving tool could ship a single
 *      huge chunk; the renderer must not blindly store a multi-MB
 *      string into state.
 *
 *   3. **Per-tool cap**: once the merged `outputChunks` exceeds
 *      `maxChunks` count OR `maxTotalChars` total characters,
 *      oldest chunks are dropped until both invariants hold again.
 *      This bounds renderer memory and prevents a flood of events
 *      from a runaway tool from forcing arbitrarily large state.
 *      A dropped-chunks marker is emitted as a separate
 *      `truncated: true` outcome so the UI can show a "已截断" pill.
 *
 * Dedup-by-seq and sort-by-seq stay (runtime already enforces
 * per-toolCallId monotonic seq, but the network can deliver out of
 * order; insert-sort handles both).
 *
 * The function is pure and renderer-agnostic — tests live in
 * `apps/desktop/src/main/__tests__/tool-output-stream.test.ts` and
 * exercise:
 *   - raw `Authorization: Bearer ...` / API-key text → masked in
 *     stored chunk + `redacted: true`
 *   - single oversize chunk → truncated to `maxChunkChars`
 *   - 1000 small chunks → state capped at `maxChunks` (oldest drops)
 *   - total chars over `maxTotalChars` → oldest drops to fit
 *   - dedup-by-seq still works
 *   - sort-by-seq still works (out-of-order arrival)
 *   - `truncated: false` when no cap hit
 */

import { TOOL_OUTPUT_DELTA_MAX_CHARS } from '@maka/core/events';
import type { ToolOutputChunk } from './materialize.js';
import { redactSecrets } from './redact.js';
import type { UiLocale } from '@maka/core/ui-locale';
import { getSharedUiCopy } from './shared-ui-copy.js';

/**
 * Default caps. Tuned to:
 *   - 16 KB total chars: well above any reasonable single tool
 *     interactive output (1-2 screens of terminal), well below a
 *     "browser slow" threshold for live append.
 *   - 200 chunks: enough headroom that streamed line-by-line
 *     output of a 100-line script never hits the cap, while still
 *     bounding state churn for runaway tools.
 *   - Runtime event limit per chunk: matches
 *     `TOOL_OUTPUT_DELTA_MAX_CHARS` so renderer cap is consistent
 *     with main-side truncation; a chunk that arrives larger than
 *     this is a contract violation and we tail-truncate defensively.
 */
export const TOOL_STREAM_MAX_CHUNKS = 200;
export const TOOL_STREAM_MAX_TOTAL_CHARS = 16 * 1024;
export const TOOL_STREAM_MAX_CHUNK_CHARS = TOOL_OUTPUT_DELTA_MAX_CHARS;

export interface ApplyToolOutputChunkOptions {
  maxChunks?: number;
  maxTotalChars?: number;
  maxChunkChars?: number;
  locale?: UiLocale;
}

export interface ApplyToolOutputChunkResult {
  /** The new `outputChunks` list. Sorted by `seq`; deduped. */
  chunks: ToolOutputChunk[];
  /**
   * `true` if this call dropped any chunks OR truncated a chunk
   * (per-chunk cap, per-tool count cap, or per-tool total-char cap).
   * The renderer sets a "已截断" pill on the tool item when true.
   */
  truncated: boolean;
  /**
   * `true` if redaction modified `rawChunk.text` during this call.
   * Useful for telemetry / debug; the chunk's own `redacted` flag is
   * already updated.
   */
  redacted: boolean;
}

/**
 * Apply a single incoming `tool_output_delta` chunk to the running
 * list. Returns the new list, plus flags for whether redaction
 * happened and whether any chunk was dropped/truncated.
 *
 * Behavior:
 *   - Redacts `rawChunk.text` via `redactSecrets`. Sets the stored
 *     chunk's `redacted: true` if the text changed or if the input
 *     already had `redacted: true`.
 *   - Per-chunk cap: if `text.length > maxChunkChars`, keeps the
 *     last `maxChunkChars` chars and prepends a truncation marker.
 *     (Tail-keep, not head-keep, so the most recent output is what
 *     the user sees; matches a `tail -c` mental model.)
 *   - Dedups by `seq` (returns `prev` unchanged if the seq is
 *     already present).
 *   - Inserts in sorted order by `seq`.
 *   - Drops oldest chunks until `length <= maxChunks` AND total
 *     chars `<= maxTotalChars`. Sets `truncated: true` if any drop
 *     or per-chunk truncation occurred.
 */
export function applyToolOutputChunk(
  prevChunks: ToolOutputChunk[] | undefined,
  rawChunk: ToolOutputChunk,
  options: ApplyToolOutputChunkOptions = {},
): ApplyToolOutputChunkResult {
  const maxChunks = options.maxChunks ?? TOOL_STREAM_MAX_CHUNKS;
  const maxTotalChars = options.maxTotalChars ?? TOOL_STREAM_MAX_TOTAL_CHARS;
  const maxChunkChars = options.maxChunkChars ?? TOOL_STREAM_MAX_CHUNK_CHARS;
  const truncatedChunkMarker = getSharedUiCopy(options.locale ?? 'zh').stream.toolChunkTruncated;

  const list = prevChunks ?? [];

  // Dedup-by-seq: if the seq is already present, return prev untouched.
  // This MUST happen before we burn CPU on redaction/truncation for a
  // chunk that's already in the list.
  if (list.some((existing) => existing.seq === rawChunk.seq)) {
    return { chunks: list, redacted: false, truncated: false };
  }

  // L1: secondary redaction. The renderer doesn't get to trust
  // upstream's redactor; we mask again here so React state never
  // contains raw secrets.
  const redactedText = redactSecrets(rawChunk.text);
  const redactionHappened = redactedText !== rawChunk.text;

  // L2: per-chunk cap. A single oversize chunk gets tail-kept;
  // we prepend a marker so the user knows the head was dropped.
  let storedText = redactedText;
  let chunkTruncated = false;
  if (storedText.length > maxChunkChars) {
    const tail = storedText.slice(storedText.length - maxChunkChars + truncatedChunkMarker.length);
    storedText = truncatedChunkMarker + tail;
    chunkTruncated = true;
  }

  const storedChunk: ToolOutputChunk = {
    ...rawChunk,
    text: storedText,
    redacted: rawChunk.redacted || redactionHappened,
  };

  // Sorted insert by seq.
  const merged = [...list, storedChunk].sort((a, b) => a.seq - b.seq);

  // L3: per-tool count + total-chars caps. Drop oldest until both
  // invariants hold. Loop bounded by current length so worst-case
  // O(n) even on a flood.
  let dropped = false;
  let chunks = merged;
  while (chunks.length > maxChunks) {
    chunks = chunks.slice(1);
    dropped = true;
  }
  let totalChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
  while (totalChars > maxTotalChars && chunks.length > 0) {
    totalChars -= chunks[0]!.text.length;
    chunks = chunks.slice(1);
    dropped = true;
  }

  return {
    chunks,
    redacted: redactionHappened,
    truncated: chunkTruncated || dropped,
  };
}
