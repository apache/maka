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
 * Unicode text-sanitize pipeline — single source of truth (#1404).
 *
 * `session-name.ts` and `foreign-session.ts` each used to carry their own copy
 * of the "NFC + control/bidi/zero-width + whitespace-collapse + code-point
 * cap" pipeline, and the two had drifted: `session-name` was missing 8 code
 * points that `foreign-session` (and its own `FOREIGN_UNSAFE_CHARS` id guard)
 * already covered. This module is the one place that pipeline lives now.
 *
 * Boundary: this helper does ONE thing — given an already-type-checked string,
 * clean it and cap it. It is deliberately agnostic about:
 *   - the runtime type guard (`unknown` → reject vs coerce),
 *   - the empty-after-sanitize policy (reject vs return `''`),
 *   - the return shape (`Result` vs bare string).
 * Those are caller policies and stay with the callers, so each surface keeps
 * its existing contract while sharing the same character classes.
 *
 * NOT a security boundary on its own — NFC canonicalization doesn't stop bidi
 * spoofing; the bidi/zero-width steps below do. Apply at every trust boundary
 * where untrusted text may reach storage or a prompt.
 */

// Regex character classes use escaped `\uXXXX` ranges, NOT literal control
// bytes: literal U+0000 / bidi / zero-width bytes in source make git treat the
// TS file as binary, which breaks diff/patch review and the merge gate's
// source grep. The `\u....` form compiles to an identical regex at runtime but
// keeps the source readable as plain text.

// C0 control characters: U+0000..U+001F (NUL through US), U+007F (DEL),
// U+0080..U+009F (C1 controls). Replaced with single space so multi-line input
// becomes readable single-line (`foo\nbar` → `foo bar`, not `foobar`).
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F-\u009F]/g;

// Bidi format characters that can spoof display direction. Replaced with space
// (not removed) so adjacent words remain separated.
//   U+061C  ALM (Arabic letter mark)
//   U+200E  LRM (left-to-right mark)
//   U+200F  RLM (right-to-left mark)
//   U+202A  LRE, U+202B RLE, U+202C PDF, U+202D LRO, U+202E RLO
//   U+2066  LRI, U+2067 RLI, U+2068 FSI, U+2069 PDI
const BIDI_FORMAT_REGEX = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// Zero-width / invisible format characters. Removed entirely (no replacement)
// because they're meant to be invisible and replacing with space would inject
// visible whitespace into legitimate CJK/emoji sequences that may contain ZWJ
// for compound emoji. NOTE: U+200D (ZWJ) is in the set, but emoji that use ZWJ
// internally are compound-grapheme sequences (👨‍👩‍👧); removing the joiner does
// not corrupt the code points, it only splits the ligature rendering — the
// lesser evil vs. leaving a zero-width injection vector open.
//   U+200B  ZWSP, U+200C ZWNJ, U+200D ZWJ
//   U+2060  WJ (word joiner), U+2061 IT, U+2062 IS, U+2063 IP, U+2064 IP
//   U+FEFF  BOM / zero-width no-break space
const ZERO_WIDTH_REGEX = /[\u200B-\u200D\u2060-\u2064\uFEFF]/g;

export interface SanitizeUnicodeOptions {
  /** Hard cap on the number of Unicode code points in the cleaned string. */
  maxCodePoints: number;
  /**
   * Appended when the cleaned string exceeds `maxCodePoints` and is truncated.
   * Defaults to `'…'`. Pass `''` for a silent cap (no visible marker).
   */
  truncatedSuffix?: string;
}

/**
 * Clean and truncate untrusted Unicode text.
 *
 * Pipeline (applied in order): NFC → control chars → space, bidi format →
 * space, zero-width/invisible → removed, whitespace collapse, trim, then
 * code-point cap. The cap uses `Array.from(...)` to iterate by code points so a
 * surrogate pair (e.g. `🦊` = U+1F98A, two UTF-16 code units) counts as one and
 * is never split in half.
 *
 * Empty input (or input that sanitizes down to `''`) returns `''`; the caller
 * decides whether that's acceptable.
 */
export function sanitizeUnicodeText(text: string, opts: SanitizeUnicodeOptions): string {
  const suffix = opts.truncatedSuffix ?? '…';
  const cleaned = text
    .normalize('NFC')
    .replace(CONTROL_CHARS_REGEX, ' ')
    .replace(BIDI_FORMAT_REGEX, ' ')
    .replace(ZERO_WIDTH_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(cleaned);
  if (points.length <= opts.maxCodePoints) return cleaned;
  return points.slice(0, opts.maxCodePoints).join('') + suffix;
}
