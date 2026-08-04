#!/usr/bin/env node
/**
 * Workspace accessibility audit. This script is the executable source of
 * truth for the static checks below.
 *
 * Walks all .tsx source under apps/ and packages/ (excluding __tests__/,
 * dist/, node_modules/) and flags common accessibility regressions:
 *
 *  1. **Icon-only buttons** — `<button>` whose only children are
 *     self-closing JSX elements (e.g. `<Icon />`) and which lack
 *     `aria-label` or `aria-labelledby`. These are unannounceable to
 *     screen readers.
 *
 *  2. **Positive tabIndex** — `tabIndex={N}` with N > 0. Positive
 *     tabIndex breaks the natural DOM tab order; UI gate § 3.2 bans it.
 *
 * Like `check-console.mjs`, this script lives outside ESLint to keep
 * tooling surface minimal. Run via `pretest` hook in @maka/desktop.
 *
 * Future rules should be added to the RULES array without changing the
 * caller contract (e.g. icon-only links, dialog labels, input labels).
 *
 * To add a legitimate exception, add a `// a11y-allow: <reason>` comment
 * on the same line as the offending element. The allow-list is in-source,
 * not in this file, so reviewers see the justification next to the code.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOTS = ['apps', 'packages'];
const EXTS = new Set(['.tsx']);
// `primitives/` holds vendored upstream primitive source components that ship with
// English aria-labels. They're rewritten with Chinese labels when
// each consumer surface wires them up, so the a11y walker treats
// them like third-party source that doesn't run through the same
// gate. The wrappers in `./ui.tsx` and the call sites themselves
// remain subject to the full check.
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'primitives']);

async function walk(root) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf('.');
        const ext = dot >= 0 ? entry.name.slice(dot) : '';
        if (EXTS.has(ext)) out.push(full);
      }
    }
  }
  await visit(root);
  return out;
}

// Each rule is { name, scan(line, prevLines, nextLines) -> message | null }.
// Lines are checked one at a time with a small lookahead/lookbehind for
// multi-line opening tags. `// a11y-allow: <reason>` on the same line
// silences the rule for that line.

const RULES = [
  {
    name: 'icon-only-button',
    /**
     * Catches `<button … >` whose immediate children are only self-closing
     * JSX elements (typically icons). Skips:
     *  - buttons with children that include text
     *  - buttons with aria-label / aria-labelledby
     *  - lines containing `// a11y-allow:`
     */
    scan(text) {
      const offenders = [];
      // Strip line comments first — they may contain text that looks like JSX.
      const stripped = text.replace(/\/\/.*$/gm, '');
      // Match `<button …>` opening tag (single-line for now; multi-line
      // tags get less coverage but we accept that for the gate).
      const BUTTON_OPEN_RE = /<button\b([^>]*)>/gi;
      let match;
      while ((match = BUTTON_OPEN_RE.exec(stripped))) {
        const attrs = match[1] ?? '';
        const start = match.index + match[0].length;
        const close = stripped.indexOf('</button>', start);
        if (close < 0) continue;
        const body = stripped.slice(start, close);
        // a11y-allow comment in the same opening tag → skip
        const fullDecl = stripped.slice(Math.max(0, match.index - 200), close);
        if (/\/\/\s*a11y-allow:/.test(fullDecl)) continue;
        // Has aria-label or aria-labelledby → OK
        if (/\baria-label(?:ledby)?\s*=/.test(attrs)) continue;
        // Has visible text content? Two checks (either passes):
        //   (a) Plain text after stripping nested JSX tags
        //   (b) Any string literal inside `{...}` expressions (e.g.
        //       `{busy ? '保存中…' : '保存'}`) — common pattern for
        //       conditional text labels.
        const textOnly = body
          .replace(/<[^>]+>/g, '')
          .replace(/\{[^}]*\}/g, '')
          .trim();
        if (textOnly.length > 0 && /[a-zA-Z一-鿿]/.test(textOnly)) continue;
        if (/['"`][^'"`]*[a-zA-Z一-鿿][^'"`]*['"`]/.test(body)) continue;
        // Has a {label} expression child like {label} {someText}? Accept —
        // we can't statically check that the expression resolves to text,
        // but it's common-enough that ruling it out has too many false positives.
        if (/\{[^{}]*(label|name|text|title|alt|description)/i.test(body)) continue;
        const lineIndex = text.slice(0, match.index).split('\n').length;
        offenders.push({ line: lineIndex, snippet: match[0].trim() });
      }
      return offenders;
    },
  },
  {
    name: 'positive-tabindex',
    scan(text) {
      const offenders = [];
      const POSITIVE_TABINDEX = /\btabIndex\s*=\s*\{?(\d+)\}?/g;
      let match;
      while ((match = POSITIVE_TABINDEX.exec(text))) {
        const value = Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) continue;
        // a11y-allow comment on same line → skip
        const lineStart = text.lastIndexOf('\n', match.index) + 1;
        const lineEnd = text.indexOf('\n', match.index);
        const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
        if (/\/\/\s*a11y-allow:/.test(line)) continue;
        const lineIndex = text.slice(0, match.index).split('\n').length;
        offenders.push({ line: lineIndex, snippet: match[0].trim() });
      }
      return offenders;
    },
  },
  {
    name: 'dialog-missing-label',
    /**
     * Catches elements with `role="dialog"` that lack a label
     * (`aria-label` or `aria-labelledby`). Without a label, screen
     * readers announce "dialog" with no context.
     */
    scan(text) {
      const offenders = [];
      const DIALOG_RE = /<(\w+)\b([^>]*\brole\s*=\s*["']dialog["'][^>]*)>/g;
      let match;
      while ((match = DIALOG_RE.exec(text))) {
        const attrs = match[2] ?? '';
        // a11y-allow comment within the same element opening
        const before = text.slice(Math.max(0, match.index - 200), match.index + match[0].length);
        if (/\/\/\s*a11y-allow:/.test(before)) continue;
        if (/\baria-label(?:ledby)?\s*=/.test(attrs)) continue;
        const lineIndex = text.slice(0, match.index).split('\n').length;
        offenders.push({ line: lineIndex, snippet: match[0].trim().slice(0, 120) });
      }
      return offenders;
    },
  },
  {
    name: 'input-missing-label',
    /**
     * Catches `<input>` and `<textarea>` elements that have no
     * accessible name. An input is OK when:
     *  - it has `aria-label` / `aria-labelledby`
     *  - it has `placeholder` (weak, but Maka relies on it for
     *    several search/proxy fields — not WCAG AA but common)
     *  - it's a hidden / file / image / submit / reset / button type
     *    (those self-label or are non-interactive in this sense)
     *  - it's directly inside a `<label>` element (parent label
     *    associates implicitly)
     *
     * The detection is structural-regex; missing edge cases are
     * acceptable false negatives.
     */
    scan(text) {
      const offenders = [];
      // JSX arrow functions `(event) => ...` contain `>` which breaks
      // greedy `[^>]*` attribute capture — the regex would stop at the
      // arrow's `>` instead of the tag's `>`. Pre-replace `=>` with
      // `=≫` (U+226B "much greater-than") so the `>` is no longer
      // present. Both are single UTF-16 code units so character
      // indices stay aligned with the original text.
      const safe = text.replace(/=>/g, '=≫');
      // Don't strip comments — same line-offset bug we hit on
      // english-aria-label (PR-IR-05). String attributes can't
      // legitimately contain `//` anyway.
      const INPUT_RE = /<(input|textarea)\b([^>]*?)\/?>/g;
      let match;
      while ((match = INPUT_RE.exec(safe))) {
        const attrs = match[2] ?? '';
        // a11y-allow on same line
        const lineStart = text.lastIndexOf('\n', match.index) + 1;
        const lineEnd = text.indexOf('\n', match.index);
        const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
        if (/\/\/\s*a11y-allow:/.test(line)) continue;
        // aria-label / aria-labelledby → OK
        if (/\baria-label(?:ledby)?\s*=/.test(attrs)) continue;
        // placeholder → soft OK (placeholders are commonly the only
        // label for Maka's quick-text inputs; we mark them as weakly
        // labeled but don't flag)
        if (/\bplaceholder\s*=/.test(attrs)) continue;
        // hidden / file / image / submit / reset / button input types
        const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/);
        if (typeMatch && /^(hidden|file|image|submit|reset|button)$/i.test(typeMatch[1])) continue;
        // Check if a parent <label> wraps this input — look at the
        // 600 chars before the match and see if any <label> opens
        // without closing first.
        const lookBack = text.slice(Math.max(0, match.index - 600), match.index);
        const lastLabelOpen = lookBack.lastIndexOf('<label');
        const lastLabelClose = lookBack.lastIndexOf('</label>');
        if (lastLabelOpen > lastLabelClose) continue;
        const lineIndex = text.slice(0, match.index).split('\n').length;
        offenders.push({ line: lineIndex, snippet: match[0].trim().slice(0, 120) });
      }
      return offenders;
    },
  },
  {
    name: 'icon-only-link',
    /**
     * Same shape as icon-only-button but for `<a href>` links — an
     * anchor with only icon children needs an aria-label so AT can
     * announce it.
     */
    scan(text) {
      const offenders = [];
      const stripped = text.replace(/\/\/.*$/gm, '');
      const ANCHOR_OPEN_RE = /<a\s+([^>]*\bhref\s*=[^>]*)>/g;
      let match;
      while ((match = ANCHOR_OPEN_RE.exec(stripped))) {
        const attrs = match[1] ?? '';
        const start = match.index + match[0].length;
        const close = stripped.indexOf('</a>', start);
        if (close < 0) continue;
        const body = stripped.slice(start, close);
        const fullDecl = stripped.slice(Math.max(0, match.index - 200), close);
        if (/\/\/\s*a11y-allow:/.test(fullDecl)) continue;
        if (/\baria-label(?:ledby)?\s*=/.test(attrs)) continue;
        const textOnly = body
          .replace(/<[^>]+>/g, '')
          .replace(/\{[^}]*\}/g, '')
          .trim();
        if (textOnly.length > 0 && /[a-zA-Z一-鿿]/.test(textOnly)) continue;
        if (/['"`][^'"`]*[a-zA-Z一-鿿][^'"`]*['"`]/.test(body)) continue;
        if (
          /\{[^{}]*(label|name|text|title|alt|description|url|href|children|content|message)/i.test(
            body,
          )
        )
          continue;
        const lineIndex = text.slice(0, match.index).split('\n').length;
        offenders.push({ line: lineIndex, snippet: match[0].trim() });
      }
      return offenders;
    },
  },
  {
    name: 'english-aria-label',
    /**
     * PR-IR-05 / i18n contract: any `aria-label` / `title` /
     * `placeholder` attribute with a string literal value that is all
     * English (no CJK) is a likely missing translation. Real Chinese
     * UI labels naturally contain `[一-鿿]` characters.
     *
     * Skips:
     *   - whitelisted technical/brand terms (URL, API, OAuth, …)
     *   - very short strings (< 4 chars — typically tokens or `OK` /
     *     `New` that are too short to risk false positives without a
     *     proper i18n catalog)
     *   - `// a11y-allow:` exception comments
     *   - test files / __tests__ already excluded by walker
     *
     * Detects user-visible-text attributes only. Internal `data-*` /
     * `className` / `id` / `aria-controls` are not checked.
     */
    scan(text) {
      const offenders = [];
      // Single-line attribute match — value can't contain quote chars or
      // line breaks. We don't strip comments here because attribute string
      // literals can't legitimately contain `//`, and stripping would
      // throw off `match.index` line-number calculation.
      const ATTR_RE = /\b(aria-label|title|placeholder)\s*=\s*(['"])([^'"\n]+)\2/g;
      let match;
      while ((match = ATTR_RE.exec(text))) {
        const attrName = match[1] ?? '';
        const value = match[3] ?? '';
        if (value.length < 4) continue;
        // Has any CJK char → assume Chinese / already translated
        if (/[一-鿿]/.test(value)) continue;
        // No Latin letters at all → not a sentence, skip
        if (!/[a-zA-Z]/.test(value)) continue;
        // Placeholders for example URLs / domains / slugs / tokens are
        // template values, not user instructions. Skip these.
        if (attrName === 'placeholder' && looksLikeExampleValue(value)) continue;
        // Allow-list common technical / brand terms commonly left in English
        // (model IDs, brand names, technical abbreviations). Match when the
        // entire value is composed of allow-listed tokens.
        if (isAllowedEnglishTerm(value)) continue;
        // Same-line exception comment
        const lineStart = text.lastIndexOf('\n', match.index) + 1;
        const lineEnd = text.indexOf('\n', match.index);
        const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
        if (/\/\/\s*a11y-allow:/.test(line) || /\/\/\s*i18n-allow:/.test(line)) continue;
        const lineIndex = text.slice(0, match.index).split('\n').length;
        offenders.push({
          line: lineIndex,
          snippet: `${attrName}="${value.slice(0, 60)}${value.length > 60 ? '…' : ''}"`,
        });
      }
      return offenders;
    },
  },
  {
    name: 'aria-label-on-generic',
    /**
     * Catches `aria-label` / `aria-labelledby` on an element whose role
     * cannot carry a name. ARIA prohibits naming the `generic` role, so a
     * label on a bare `<div>` or `<span>` is not a weak name — it is no name
     * at all, and assistive tech never reads it. The failure is silent: the
     * markup looks labelled and reviews read as if it were.
     *
     * This is how the Permission Center lost its capability list's name when
     * the rows moved from Astryx `List` (`role="list"`, nameable) to a
     * `CollapsibleGroup` whose wrapper is a role-less div (PR #2100).
     *
     * Before deleting a flagged label, check whether it is naming something
     * ELSE. The accessible-name algorithm walks descendants, so a label on an
     * inner span still lands in an interactive ancestor's name-from-content —
     * and for Astryx's Item it is the only thing that can, because Item puts
     * consumer props on its outer wrapper and renders a separate invisible
     * <button> as the click target. Prefer moving the label onto the element
     * that is actually interactive; where the component gives you no way to do
     * that, the inner label IS the mechanism and belongs in an a11y-allow.
     *
     * Scope, and its honest limit: only intrinsic lowercase elements are
     * judged. A capitalized component may set its own role internally — `List`
     * does — so flagging `<SomeComponent aria-label>` would be guesswork and
     * a flood of false positives. That means this rule would NOT have caught
     * the #2100 regression itself, which was a component. It catches the
     * directly checkable half; the component half stays a review question.
     *
     * Only tags whose implicit role is `generic` (or otherwise name-prohibited)
     * are listed. Tags with a nameable implicit role — nav, section, img,
     * table, ul, svg, form, … — are legitimately labelled and never flagged.
     */
    scan(text) {
      const offenders = [];
      const stripped = text.replace(/\/\/.*$/gm, '');
      // Implicit role is `generic` (or presentational): naming is prohibited.
      const NAME_PROHIBITED = new Set([
        'div',
        'span',
        'p',
        'pre',
        'code',
        'em',
        'strong',
        'small',
        'b',
        'i',
        'u',
        's',
        'mark',
        'q',
        'cite',
        'dfn',
        'abbr',
        'time',
        'data',
        'kbd',
        'samp',
        'var',
        'figcaption',
        'sub',
        'sup',
      ]);
      const OPEN_RE = /<([a-z][a-zA-Z0-9-]*)((?:[^<>{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?)\/?>/g;
      let match;
      while ((match = OPEN_RE.exec(stripped))) {
        const tag = match[1];
        const attrs = match[2] ?? '';
        if (!NAME_PROHIBITED.has(tag)) continue;
        if (!/\baria-label(?:ledby)?\s*=/.test(attrs)) continue;
        // An explicit role makes the element nameable — that is the fix.
        if (/\brole\s*=/.test(attrs)) continue;
        // Spread props may carry a role we cannot see (`{...props}`); assume
        // the author knows and stay quiet rather than cry wolf.
        if (/\{\s*\.\.\./.test(attrs)) continue;
        // Offsets index into `stripped`, and comment removal preserves
        // newlines, so line numbers must be counted there too — counting in
        // `text` drifts by every comment character removed before the match.
        const lineIndex = stripped.slice(0, match.index).split('\n').length;
        // The allow comment lives in the ORIGINAL source (stripping removed
        // the `//` form), so look it up by line rather than by offset. Inside
        // a JSX tag a `//` comment is not legal, so the JSX block form
        // `{/* a11y-allow: … */}` on the line above counts too — otherwise the
        // escape hatch would be unusable exactly where this rule fires.
        const sourceLines = text.split('\n');
        const declLines = sourceLines
          .slice(Math.max(0, lineIndex - 2), lineIndex - 1 + match[0].split('\n').length)
          .join('\n');
        if (/(?:\/\/|\{\s*\/\*)\s*a11y-allow:/.test(declLines)) continue;
        offenders.push({
          line: lineIndex,
          snippet: `<${tag}> carries aria-label but has no role that can hold a name`,
        });
      }
      return offenders;
    },
  },
];

/**
 * Allow-list for common technical / brand / English terms that don't need
 * translation. Returns true when the entire value (after stripping
 * punctuation/digits) is composed of allowed tokens.
 *
 * Be conservative: false negatives are OK (we err on letting English
 * through; the gate is meant to catch *forgotten* translations, not
 * impose Chinese on every brand name).
 */
const ALLOWED_ENGLISH_PATTERNS = [
  // The app's own product name — a proper noun, kept in Latin script
  // everywhere (About hero title, brand marks). Not a missing translation.
  /^Maka$/,
  // Model providers / brand names
  /^OpenAI$/i,
  /^Anthropic$/i,
  /^Claude\b/i,
  /^GPT-?\d/i,
  /^Gemini\b/i,
  /^Llama\b/i,
  /^DeepSeek$/i,
  /^Z\.AI$/i,
  /^Z\.ai$/i,
  /^GLM-[\d.]+/i,
  // Common technical abbreviations
  /^(API|URL|JSON|YAML|HTTP|HTTPS|HTML|CSS|UTF-?8|UUID|JWT|TLS|SSL|MCP|LLM|UI|UX|CLI|MD|PDF|PNG|SVG|JPG|JPEG|WebP)$/i,
  /^OAuth(?:\s*\d)?$/i,
  /^WebSocket$/i,
  /^localhost(?::\d+)?$/i,
  // Generic placeholders rarely user-facing in a way that matters
  /^https?:\/\//i,
  /^[A-Z][a-z]+ID$/, // sessionID, etc.
];

/**
 * Detects placeholder values that are example formats (URL, domain,
 * slug, token, hostname:port) rather than user-facing instructions.
 * These don't need translation.
 */
function looksLikeExampleValue(value) {
  // Strip the unicode ellipsis (U+2026) and ASCII "..." used to indicate
  // truncated example text — they don't change the example nature.
  const trimmed = value.trim().replace(/…+|\.\.\.+/g, '');
  // Single bare word like "my-provider" or "model-id"
  if (/^[a-z][a-z0-9-]*$/.test(trimmed)) return true;
  // PR-BOT-WECHAT-SCAN-LOGIN-0: developer credential placeholders that
  // use lowercase + underscore + 'x' wildcards as the canonical example,
  // e.g. "cli_xxxx" (飞书 App ID), "dingxxxxxxxx" (钉钉 AppKey).
  if (/^[a-z][a-z0-9_-]*$/.test(trimmed)) return true;
  // Token-prefix style placeholders that mix uppercase + lowercase, e.g.
  // "MTAx" (Discord Bot Token prefix).
  if (/^[A-Z][A-Za-z0-9_-]*$/.test(trimmed)) return true;
  // Numeric-prefix wildcards like "102xxxxxx" (QQ AppID).
  if (/^[0-9]+x+$/i.test(trimmed)) return true;
  // URL / scheme
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^[a-z]+:\/\//i.test(trimmed)) return true;
  // Comma-separated domains: "metaso.cn, baidu.com"
  if (/^[a-z0-9.-]+\.[a-z]{2,}(,\s*[a-z0-9.-]+\.[a-z]{2,})*$/i.test(trimmed)) return true;
  // Token format: "123456:ABC-DEF" / "123456:ABC-DEF…"
  if (/^[0-9]+:[A-Z0-9_-]+$/.test(trimmed)) return true;
  // hostname:port
  if (/^[a-z0-9.-]+:\d+$/i.test(trimmed)) return true;
  return false;
}

function isAllowedEnglishTerm(value) {
  const trimmed = value.trim();
  for (const pattern of ALLOWED_ENGLISH_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  // Composite values: split by space/punct, check each token
  const tokens = trimmed.split(/[\s.,:;\-_/()[\]]+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => ALLOWED_ENGLISH_PATTERNS.some((p) => p.test(token)));
}

async function main() {
  const offenders = [];
  for (const root of ROOTS) {
    const files = await walk(join(REPO_ROOT, root));
    for (const file of files) {
      const rel = relative(REPO_ROOT, file).split('\\').join('/');
      const src = await readFile(file, 'utf8');
      for (const rule of RULES) {
        const hits = rule.scan(src);
        for (const hit of hits) {
          offenders.push({ path: rel, rule: rule.name, line: hit.line, snippet: hit.snippet });
        }
      }
    }
  }
  if (offenders.length === 0) {
    console.log(`[check-a11y] OK — ${RULES.map((r) => r.name).join(', ')} all clean.`);
    return;
  }
  console.error(`[check-a11y] FAILED — ${offenders.length} a11y violations:`);
  for (const o of offenders) {
    console.error(`  [${o.rule}] ${o.path}:${o.line}`);
    console.error(`    ${o.snippet}`);
  }
  console.error('');
  console.error('Fix options:');
  console.error('  - icon-only-button     → add `aria-label="<chinese label>"`');
  console.error('  - icon-only-link       → add `aria-label="<chinese label>"`');
  console.error(
    '  - positive-tabindex    → use natural DOM order; `tabIndex={0}` or `tabIndex={-1}` only',
  );
  console.error('  - dialog-missing-label → add `aria-label` or `aria-labelledby` to the dialog');
  console.error(
    '  - input-missing-label  → wrap with `<label>`, or add `aria-label` / `placeholder`',
  );
  console.error('  - english-aria-label   → translate to Chinese, or `// i18n-allow: <reason>`');
  console.error('');
  console.error('Genuine exceptions: add `// a11y-allow: <reason>` on the same line.');
  process.exit(1);
}

main().catch((err) => {
  console.error('[check-a11y] unexpected error:', err);
  process.exit(2);
});
