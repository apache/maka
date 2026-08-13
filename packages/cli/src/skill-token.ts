/**
 * `/skill:<name>` invocation tokens (issue #1148) — the TUI's serialization
 * of an explicit skill invocation. A token is valid anywhere in the input as
 * long as it starts the text or follows whitespace (so paths and URLs never
 * produce false positives); `<name>` uses the skill id charset, and
 * resolution downstream matches by id first, then by display name.
 *
 * This module owns the TUI's use of the token syntax: parsing for submit-time
 * injection, stripping for message composition, and the line pattern the
 * editor highlighter and autocomplete run per line. The grammar itself is
 * `SKILL_INVOCATION_TOKEN_SOURCE` in `@maka/core`, shared with the Desktop
 * composer; loading/gating/composing lives in `@maka/runtime`'s
 * skill-invocation module.
 */

import { SKILL_INVOCATION_TOKEN_SOURCE } from '@maka/core/skill-invocation-token';

export interface SkillInvocationToken {
  /** The id-or-name captured after the `/skill:` prefix, exactly as typed. */
  name: string;
  /** Start offset of the full token (including the prefix) in the source text. */
  start: number;
  /** End offset (exclusive) of the full token in the source text. */
  end: number;
}

/** Re-exported so per-line consumers in this package keep one import site. */
export { SKILL_INVOCATION_TOKEN_SOURCE };

const TOKEN_PATTERN = new RegExp(SKILL_INVOCATION_TOKEN_SOURCE, 'g');

/**
 * Parse the distinct invocation tokens in `text`, in first-appearance order,
 * deduped case-insensitively by name. Positions point at the first
 * occurrence of each name.
 */
export function parseSkillInvocationTokens(text: string): SkillInvocationToken[] {
  const tokens: SkillInvocationToken[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const name = match[1];
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const start = match.index;
    tokens.push({ name, start, end: start + match[0].length });
  }
  return tokens;
}

/**
 * Remove every occurrence of the named tokens from `text`. Only lines that
 * actually contained a removed token are tidied (adjacent whitespace
 * collapsed around the hole; the line is dropped if left empty) — every
 * other line passes through byte-identical, so code blocks and intentional
 * spacing elsewhere are untouched. The result is NOT global-trimmed: leading
 * or trailing whitespace that is not itself a removed-token line is kept so
 * indented code/YAML after a token-only line survives.
 */
export function stripSkillInvocationTokens(text: string, names: ReadonlySet<string>): string {
  const pattern = new RegExp(SKILL_INVOCATION_TOKEN_SOURCE, 'g');
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    let touched = false;
    const stripped = line.replace(pattern, (whole, name: string) => {
      if (!names.has(name.toLowerCase())) return whole;
      touched = true;
      return '';
    });
    if (!touched) {
      out.push(line);
      continue;
    }
    // Collapse spaces left by the token hole on this line only. Untouched
    // lines (including indented code after a token-only line) stay byte-identical
    // because we never global-trim the joined result.
    const tidied = stripped.replace(/[ \t]+/g, ' ').trim();
    if (tidied.length > 0) out.push(tidied);
  }
  return out.join('\n');
}

/**
 * The token prefix directly before the cursor on the cursor's own line, if
 * any — the autocomplete trigger shape. `query` is the partial name typed so
 * far (may be empty); `prefix` is the full `/skill:<query>` span to replace.
 */
export function skillInvocationPrefixAt(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): { prefix: string; query: string } | null {
  const currentLine = lines[cursorLine] || '';
  const beforeCursor = currentLine.slice(0, cursorCol);
  const match = /(?:^|\s)(\/skill:([A-Za-z0-9._-]*))$/.exec(beforeCursor);
  if (!match) return null;
  return { prefix: match[1], query: match[2] };
}
