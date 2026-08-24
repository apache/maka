// packages/runtime/src/edit-replace.ts
//
// Shared, fault-tolerant string-edit logic used by Runtime Edit tools.
//
// SAFETY MODEL (the point of this module): exact-match drift (whitespace,
// indentation, escaping) is forgiven, but a fuzzy match must never silently
// land in the wrong place. Every fuzzy strategy here verifies the FULL span is
// structurally equivalent to old_string (not just anchors), and a strategy is
// only accepted when it produces exactly ONE candidate occurring exactly ONCE.
// Any ambiguity throws instead of guessing.
//
// new_string is written VERBATIM at the matched location: the fuzzy strategies
// only LOCATE the unique span, they never re-indent or rewrite the replacement.
// This matches opencode's replacers (none migrate indentation), so callers must
// supply new_string with the exact final formatting they want. Fuzzy matching is
// additionally gated to text-sized, non-binary source; exact matching is never
// gated, so a very large source is still edited with an exact snippet. This
// function operates on a string — binary-*file* byte safety is the caller's I/O
// concern.
//
// ATTRIBUTION: the fuzzy matching strategies below are adapted material under
// more than one license. Maka took them from opencode's edit.ts
// (packages/opencode/src/tool/edit.ts), which credits cline diff-apply and the
// gemini-cli editCorrector upstream of itself; those two upstreams are
// Apache-2.0, so this region is not uniformly MIT. Each piece is listed with
// the license that governs it. All three are modified here: see below.
//
//   `lineTrimmedSpans` — adapted from cline's `lineTrimmedFallbackMatch`.
//     Source:    https://github.com/cline/cline
//     Revision:  50b43c0559a9658a4fda79645b2cfe66cfa2f133
//     Path:      evals/diff-edits/diff-apply/diff-06-23-25.ts
//     License:   Apache-2.0
//     Copyright: Copyright 2025 Cline Bot Inc.
//     Modified:  returns every matching span instead of the first, and rejects
//                a match at EOF when old_string ended with a newline.
//
//   `escapeNormalizedSpans` unescape — the regular expression and the first
//   eight branches (n, t, r, ', ", `, \, newline), in order, are from
//   gemini-cli's `unescapeStringForGeminiBug`.
//     Source:    https://github.com/google-gemini/gemini-cli
//     Revision:  93909a2dd3bf901e8f98a9fd41e1300faa585a84
//     Path:      packages/core/src/utils/editCorrector.ts
//     License:   Apache-2.0
//     Copyright: Copyright 2025 Google LLC
//     Modified:  opencode added a ninth branch ($) and changed the pattern;
//                Maka carries opencode's result and collects spans rather than
//                rewriting the string in place.
//
//   Everything else in the cascade — the whitespace-normalized matcher, the
//   strategy ordering, and the surrounding structure.
//     Source:    https://github.com/anomalyco/opencode
//     Revision:  fc80874f45a595ff6874a4d36b1090f6a64424d2
//     License:   MIT
//     Copyright: Copyright (c) 2025 opencode
//
// Maka keeps the three distinctly-reachable full-span matchers (line-trimmed,
// whitespace-normalized, escape-normalized) and omits:
//   - indentation-flexible and trimmed-boundary, which are strictly shadowed by
//     line-trimmed / whitespace-normalized here (they add no reachable match);
//   - block-anchor and context-aware, which match on partial signal (first/last
//     line + similarity) and need a tuned similarity threshold — deliberately
//     deferred to keep wrong-location risk out.
//
// Scope: the adapted material only. The rest of this file is Maka source under
// the repository Apache-2.0 license, so there is no whole-file SPDX identifier.
// See LICENSE, THIRD-PARTY COMPONENTS for the notices.

export type EditMatchStrategy = 'exact' | 'line-trimmed' | 'whitespace' | 'escape';

export interface EditMatch {
  /** The full new file content after the replacement. */
  content: string;
  /** Which strategy located old_string ('exact' or a fuzzy strategy name). */
  matchedVia: EditMatchStrategy;
  /** 1-based first line of the matched span in the original source. */
  startLine: number;
  /** 1-based last line (inclusive) of the matched span in the original source. */
  endLine: number;
}

/**
 * Apply a single, unambiguous replacement of `oldString` with `newString` in
 * `source`, tolerating whitespace/indentation/escape drift via a guarded fuzzy
 * cascade. `where` is the caller's relative path, embedded in error messages.
 *
 * @returns the new content plus which strategy matched and the matched line
 *   range (so the caller can show the model where the edit landed).
 * @throws when old_string is absent, ambiguous, identical to new_string, too
 *   short to fuzzy-match safely, or matches a disproportionately large span.
 */
export function computeEditedSource(
  source: string,
  oldString: string,
  newString: string,
  where: string,
): EditMatch {
  // Minimum trimmed old_string length for a non-exact match.
  const MIN_FUZZY_OLD_STRING_LENGTH = 5;
  // Fuzzy scanning walks the whole source repeatedly, so it is restricted to
  // text-sized inputs. The cap is in UTF-16 code units (String#length) — the
  // actual cost metric for the indexOf/split/substring scans below, not file
  // bytes. Exact matching above is NEVER gated by these, so a very large source
  // is still edited with an exact snippet.
  const MAX_FUZZY_SOURCE_CHARS = 1_000_000;
  const MAX_FUZZY_SOURCE_LINES = 50_000;

  if (oldString === newString) {
    throw new Error(`No changes to apply in ${where}: old_string and new_string are identical`);
  }
  if (oldString === '') {
    throw new Error(`old_string must not be empty in ${where}`);
  }

  // Exact match first — counted via indexOf so a large file is not split into an
  // array of substrings just to count. Short-circuits before any fuzzy work.
  const exactCount = countOccurrences(source, oldString);
  if (exactCount === 1) {
    return finish(source, oldString, newString, 'exact');
  }
  if (exactCount > 1) {
    throw new Error(`old_string is not unique in ${where} (${exactCount} matches)`);
  }

  // Exact failed — entering fuzzy territory. Apply fuzzy-only guards up front so
  // a too-short, binary, or oversized input is rejected before any scanning.
  if (oldString.trim().length < MIN_FUZZY_OLD_STRING_LENGTH) {
    throw new Error(
      `old_string is too short for a non-exact match in ${where}; provide a longer, exact snippet`,
    );
  }
  if (source.indexOf(String.fromCharCode(0)) !== -1) {
    throw new Error(
      `Refusing a non-exact match in ${where}: the file looks binary (contains a NUL byte). Re-read it and pass exact text.`,
    );
  }
  if (
    source.length > MAX_FUZZY_SOURCE_CHARS ||
    countOccurrences(source, '\n') + 1 > MAX_FUZZY_SOURCE_LINES
  ) {
    throw new Error(
      `Refusing a non-exact match in ${where}: the file is too large to fuzzy-match safely. Re-read it and pass exact text.`,
    );
  }

  // Fuzzy strategies, increasing tolerance. Each returns FULL-span candidates
  // structurally equivalent to old_string; the loop below requires exactly one.
  const strategies: Array<[EditMatchStrategy, (content: string, find: string) => string[]]> = [
    ['line-trimmed', lineTrimmedSpans],
    ['whitespace', whitespaceNormalizedSpans],
    ['escape', escapeNormalizedSpans],
  ];

  for (const [name, finder] of strategies) {
    const spans = dedupeInContent(source, finder(source, oldString));
    if (spans.length === 0) continue;
    if (spans.length > 1) {
      throw new Error(
        `old_string matched ${spans.length} different ${name} candidates in ${where}; provide more exact context to disambiguate`,
      );
    }
    const span = spans[0];
    if (source.indexOf(span) !== source.lastIndexOf(span)) {
      throw new Error(
        `old_string matched a ${name} span that occurs more than once in ${where}; provide more exact context to disambiguate`,
      );
    }
    if (isDisproportionate(span, oldString)) {
      throw new Error(
        `Refusing ${name} match in ${where}: the matched span is much larger than old_string. Re-read the file and pass the exact text to replace.`,
      );
    }
    return finish(source, span, newString, name);
  }

  throw new Error(
    `old_string not found in ${where}; it must match the file's text including whitespace and indentation`,
  );

  // ---- helpers ----

  function finish(
    content: string,
    span: string,
    replacement: string,
    matchedVia: EditMatchStrategy,
  ): EditMatch {
    const index = content.indexOf(span);
    const before = content.slice(0, index);
    const startLine = before.split('\n').length;
    // A trailing newline in the span is the last line's terminator, not an
    // extra line, so it must not bump endLine.
    const spanLineCount = span.split('\n').length - (span.endsWith('\n') ? 1 : 0);
    const endLine = startLine + Math.max(spanLineCount, 1) - 1;
    // slice-join (not String.replace) so `$&`/`$1` in newString are literal.
    const next = before + replacement + content.slice(index + span.length);
    return { content: next, matchedVia, startLine, endLine };
  }

  function countOccurrences(haystack: string, needle: string): number {
    if (needle === '') return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      count += 1;
      index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
  }

  function dedupeInContent(content: string, candidates: string[]): string[] {
    const out: string[] = [];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (content.indexOf(candidate) === -1) continue;
      if (out.indexOf(candidate) === -1) out.push(candidate);
    }
    return out;
  }

  function lineTrimmedSpans(content: string, find: string): string[] {
    const out: string[] = [];
    const originalLines = content.split('\n');
    const findEndsWithNewline = find.endsWith('\n');
    const searchLines = find.split('\n');
    if (searchLines.length > 0 && searchLines[searchLines.length - 1] === '') {
      searchLines.pop();
    }
    if (searchLines.length === 0) return out;
    for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
      let matches = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (originalLines[i + j].trim() !== searchLines[j].trim()) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      let startIndex = 0;
      for (let k = 0; k < i; k++) startIndex += originalLines[k].length + 1;
      let endIndex = startIndex;
      for (let k = 0; k < searchLines.length; k++) {
        endIndex += originalLines[i + k].length;
        if (k < searchLines.length - 1) endIndex += 1;
      }
      // If old_string ended with a newline, the matched span must include the
      // file's newline after the last matched line; otherwise the replacement
      // would drop or duplicate a line break. When there is no such newline
      // (EOF with no trailing newline) this is not a faithful match — skip it.
      if (findEndsWithNewline) {
        const lastLine = i + searchLines.length - 1;
        if (lastLine >= originalLines.length - 1) continue;
        endIndex += 1;
      }
      out.push(content.substring(startIndex, endIndex));
    }
    return out;
  }

  function whitespaceNormalizedSpans(content: string, find: string): string[] {
    const out: string[] = [];
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
    const normalizedFind = normalize(find);
    if (normalizedFind === '') return out;
    const lines = content.split('\n');
    const findLines = find.split('\n');
    if (findLines.length === 1) {
      // Single-line old_string: match individual lines only. A multi-line
      // old_string must never collapse onto one physical line — normalize()
      // turns newlines into spaces, so an unguarded single-line scan would let
      // `a\nb` match the line `a b`, which is a wrong-location edit.
      for (let i = 0; i < lines.length; i++) {
        if (normalize(lines[i]) === normalizedFind) out.push(lines[i]);
      }
    } else {
      for (let i = 0; i <= lines.length - findLines.length; i++) {
        const block = lines.slice(i, i + findLines.length).join('\n');
        if (normalize(block) === normalizedFind) out.push(block);
      }
    }
    return out;
  }

  function escapeNormalizedSpans(content: string, find: string): string[] {
    const out: string[] = [];
    const unescape = (str: string) =>
      str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match: string, ch: string) => {
        if (ch === 'n') return '\n';
        if (ch === 't') return '\t';
        if (ch === 'r') return '\r';
        if (ch === "'") return "'";
        if (ch === '"') return '"';
        if (ch === '`') return '`';
        if (ch === '\\') return '\\';
        if (ch === '\n') return '\n';
        if (ch === '$') return '$';
        return match;
      });
    const unescapedFind = unescape(find);
    if (content.includes(unescapedFind)) out.push(unescapedFind);
    const lines = content.split('\n');
    const findLines = unescapedFind.split('\n');
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join('\n');
      if (unescape(block) === unescapedFind) out.push(block);
    }
    return out;
  }

  function isDisproportionate(span: string, find: string): boolean {
    const oldLines = find.split('\n').length;
    const spanLines = span.split('\n').length;
    if (spanLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
    if (oldLines === 1) return false;
    return span.trim().length > Math.max(find.trim().length + 500, find.trim().length * 4);
  }
}
