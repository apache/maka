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

// Display-facing defensive secret masking.
//
// This module is the single source of truth for the display-layer
// redactor shared by the desktop quiet panel (@maka/ui) and the TUI
// (@maka/cli). It was extracted from packages/ui/src/redact.ts so both
// surfaces use the same patterns and the same `<redacted>` marker.
//
// The backend (main process) has its own separate redactor in
// redaction.ts for log/persistence sanitization — the two are intentionally
// different: the display redactor prefers false positives (masking a
// benign hex is better than leaking a real token), while the backend
// redactor is stricter to avoid over-redacting structured logs.

interface Pattern {
  /** Stable identifier for the masked region in the output. */
  label: string;
  regex: RegExp;
  /** How to render the replacement; default is `<label redacted>`. */
  replacement?: (match: RegExpExecArray) => string;
  /** A matched suffix can be compacted while later characters avoid this set. */
  streamingTerminator?: RegExp;
  /** Capture group containing the contextual secret value. */
  streamingValueGroup?: number;
  /** A suffix match may be represented by a shorter equivalent token. */
  streamingReversible?: true;
}

// Order matters: more specific contextual patterns first so they don't get
// partly eaten by a broader rule (e.g. an `Authorization: Bearer [redacted] header
// must mask the whole `Bearer xxx`, not just the token portion).
const PATTERNS: Pattern[] = [
  // Authorization: Bearer <token>  /  Authorization: Basic <b64>
  {
    label: 'authorization header',
    regex: /\b(authorization\s*[:=]\s*)(bearer|basic|token)\s+([^\s"'<>]+)/gi,
    replacement: (m) => `${m[1]}${m[2]} <redacted>`,
    streamingTerminator: /[\s"'<>]/,
    streamingValueGroup: 3,
  },
  // URL query secrets:  ?key=[redacted]  ?token=[redacted]  ?api_key=[redacted]  &access_token=[redacted]
  // (runs before the api-key-header rule so the URL form isn't mangled.)
  {
    label: 'url query secret',
    regex: /([?&])(access_token|api[_-]?key|apikey|auth|token|secret|signature)=([^&\s"'<>]+)/gi,
    replacement: (m) => `${m[1]}${m[2]}=<redacted>`,
    streamingTerminator: /[&\s"'<>]/,
    streamingValueGroup: 3,
  },
  // x-api-key: [redacted]  /  api-key: [redacted]  (HTTP headers; require start-of-line or
  // a space/quote before to avoid matching the URL-query form above.)
  {
    label: 'api key header',
    regex: /(^|[\s"'<>(])((?:x-)?api[-_]?key)\s*[:=]\s*([^\s"'<>]+)/gim,
    replacement: (m) => `${m[1]}${m[2]}: <redacted>`,
    streamingTerminator: /[\s"'<>]/,
    streamingValueGroup: 3,
  },
  // Common provider key prefixes
  // OpenAI: sk-..., Anthropic: sk-ant-..., Google API: AIza..., GitHub: ghp_/gho_/ghu_/ghs_/ghr_
  // Slack tokens: xox[abprs]-...
  {
    label: 'provider api key',
    regex:
      /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gh[opusr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{16,})\b/g,
    streamingReversible: true,
  },
  // Long high-entropy hex/base64 strings (40+ chars) — best-effort catch.
  // Conservative: require word boundaries and the whole match to be one
  // alphanum/hyphen/underscore run, so we don't eat normal prose accidentally.
  {
    label: 'long opaque token',
    regex: /\b(?=[A-Fa-f0-9_-]*[A-Fa-f0-9])[A-Fa-f0-9_-]{40,}\b/g,
    streamingReversible: true,
  },
];

const DEFAULT_REPLACEMENT = '<redacted>';

/**
 * Mask obvious secret-like substrings in arbitrary runtime text. Idempotent —
 * running it twice never produces nested `<redacted>` markers.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let output = input;
  for (const pattern of PATTERNS) {
    output = output.replace(pattern.regex, (...args) => {
      const match = args as unknown as RegExpExecArray;
      return pattern.replacement ? pattern.replacement(match) : DEFAULT_REPLACEMENT;
    });
  }
  return output;
}

export interface StableStreamingRedactionSuffix {
  readonly text: string;
  readonly terminator: RegExp;
  /** Safe display prefix that can no longer interact with later deltas. */
  readonly settledPrefixText: string;
  /** Short raw suffix that can still form a higher-priority nested pattern. */
  readonly compactedSuffix: string;
}

const STREAMING_VALUE_TAIL_CHARS = 128;

/**
 * Return a contextual redaction whose secret value reaches end-of-input.
 * Such a match is prefix-stable until `terminator` arrives. The hidden middle
 * can be discarded, but a short raw tail remains mutable because a later delta
 * can complete a higher-priority contextual pattern inside the current value.
 */
export function redactStableStreamingSuffix(
  input: string,
): StableStreamingRedactionSuffix | undefined {
  for (const pattern of PATTERNS) {
    if (pattern.streamingTerminator === undefined || pattern.streamingValueGroup === undefined)
      continue;
    pattern.regex.lastIndex = 0;
    let suffixMatch: RegExpExecArray | undefined;
    for (let match = pattern.regex.exec(input); match; match = pattern.regex.exec(input)) {
      if (match.index + match[0].length === input.length) suffixMatch = match;
      if (match[0].length === 0) pattern.regex.lastIndex += 1;
    }
    pattern.regex.lastIndex = 0;
    if (suffixMatch === undefined) continue;

    const value = suffixMatch[pattern.streamingValueGroup];
    if (value === undefined) continue;
    const valueOffset = suffixMatch[0].lastIndexOf(value);
    if (valueOffset < 0) continue;
    const valueStart = suffixMatch.index + valueOffset;
    const compactedInput =
      value.length <= STREAMING_VALUE_TAIL_CHARS
        ? input
        : input.slice(0, valueStart) + value.slice(-STREAMING_VALUE_TAIL_CHARS);
    const text = redactSecrets(input);
    if (redactSecrets(compactedInput) !== text) continue;

    const settledPrefixText = redactSecrets(input.slice(0, suffixMatch.index));
    const compactedSuffix = compactedInput.slice(suffixMatch.index);
    if (settledPrefixText + redactSecrets(compactedSuffix) !== text) continue;
    return {
      text,
      terminator: pattern.streamingTerminator,
      settledPrefixText,
      compactedSuffix,
    };
  }
  return undefined;
}

export interface ReversibleStreamingRedactionSuffix {
  readonly compactedInput: string;
  readonly compactedToken: string;
  readonly continuationChars: RegExp;
}

const REVERSIBLE_TOKEN_REPRESENTATIVE_CHARS = 128;

/**
 * Shorten a provider/opaque token that reaches end-of-input. The caller must
 * retain enough real head/tail source to recover if a later word character
 * invalidates the regex boundary and makes the original token visible again.
 */
export function redactReversibleStreamingSuffix(
  input: string,
): ReversibleStreamingRedactionSuffix | undefined {
  const expected = redactSecrets(input);
  for (const pattern of PATTERNS) {
    if (pattern.streamingReversible !== true) continue;
    pattern.regex.lastIndex = 0;
    let suffixMatch: RegExpExecArray | undefined;
    for (let match = pattern.regex.exec(input); match; match = pattern.regex.exec(input)) {
      if (match.index + match[0].length === input.length) suffixMatch = match;
      if (match[0].length === 0) pattern.regex.lastIndex += 1;
    }
    pattern.regex.lastIndex = 0;
    if (suffixMatch === undefined || suffixMatch[0].length <= REVERSIBLE_TOKEN_REPRESENTATIVE_CHARS)
      continue;
    const compactedToken = suffixMatch[0].slice(0, REVERSIBLE_TOKEN_REPRESENTATIVE_CHARS);
    const compactedInput = input.slice(0, suffixMatch.index) + compactedToken;
    if (redactSecrets(compactedInput) !== expected) continue;
    return {
      compactedInput,
      compactedToken,
      continuationChars: reversibleContinuationChars(pattern.label, suffixMatch[0]),
    };
  }
  return undefined;
}

function reversibleContinuationChars(label: string, token: string): RegExp {
  if (label === 'long opaque token') return /[A-Fa-f0-9_-]/;
  if (/^gh[opusr]_/.test(token)) return /[A-Za-z0-9]/;
  if (/^xox[abprs]-/.test(token)) return /[A-Za-z0-9-]/;
  return /[A-Za-z0-9_-]/;
}
