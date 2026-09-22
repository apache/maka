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

import katex from 'katex';
import type { MarkdownInlinePlugin } from '@astryxdesign/core/Markdown';

const TOKEN_START = '\uE000MAKA_MATH:';
const TOKEN_END = '\uE001';
const TOKEN_PATTERN = /\uE000MAKA_MATH:([012]):([0-9a-f]+)\uE001/g;
const LITERAL_TOKEN_PATTERN = /^\uE000MAKA_MATH:[012]:[0-9a-f]+\uE001/;

/**
 * Renders upstream `components.math` nodes through KaTeX. The delimiter-free
 * `value` arrives exactly as the expression appeared in the source.
 */
export function MarkdownMath(props: { value: string; display: 'inline' | 'block' }) {
  const html = katex.renderToString(props.value, {
    displayMode: props.display === 'block',
    output: 'htmlAndMathml',
    strict: 'warn',
    throwOnError: false,
    trust: false,
  });
  return (
    <span
      className={
        props.display === 'block'
          ? 'maka-math maka-math-display'
          : 'maka-math maka-math-inline'
      }
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Discardable derived state owned by one MarkdownBody mount. Capacity is two
 * strings no larger than that component's currently displayed source and its
 * translated form; a rewrite resets both and unmounting drops the cache.
 */
export interface MarkdownMathCache {
  source: string;
  text: string;
  safeSourceEnd: number;
  safeTextEnd: number;
}

export function createMarkdownMathCache(): MarkdownMathCache {
  return { source: '', text: '', safeSourceEnd: 0, safeTextEnd: 0 };
}

export function prepareMarkdownMath(
  source: string,
  cache: MarkdownMathCache,
): string {
  // The caller currently supplies a full string rather than an append token,
  // so proving that a rewrite did not occur requires this prefix check. It
  // keeps the scanner on the changing tail; it does not make the full-string
  // identity check itself incremental.
  const extendsPrevious = source.startsWith(cache.source);
  if (!extendsPrevious) {
    pendingLabelScans.delete(cache);
  } else {
    const pending = pendingLabelScans.get(cache);
    if (pending !== undefined) {
      // The unfinished label is the only unsettled business: resume its scan
      // over the appended bytes instead of re-walking from its opener.
      const continued = scanLabel(source, pending);
      if (continued.kind === 'pending') {
        pendingLabelScans.set(cache, continued.state);
        cache.text += source.slice(cache.source.length);
        cache.source = source;
        return cache.text;
      }
      pendingLabelScans.delete(cache);
    }
  }
  const sourceStart = extendsPrevious ? cache.safeSourceEnd : 0;
  const textStart = extendsPrevious ? cache.safeTextEnd : 0;
  const translatedTail = translateMarkdownMath(source.slice(sourceStart), {
    startsAtLineStart: sourceStart === 0 || source[sourceStart - 1] === '\n',
    priorTextChar: cache.text[textStart - 1],
    leadingBackslashes: countPrecedingBackslashes(source, sourceStart),
    onLabelPending: (state) => {
      // The scan ran on the sliced tail, so its positions are relative to
      // sourceStart; the continuation resumes on the full source and needs
      // absolute positions.
      state.index += sourceStart;
      if (state.runStart !== null) state.runStart += sourceStart;
      state.codeSearchFrom += sourceStart;
      pendingLabelScans.set(cache, state);
    },
  });
  const text = `${extendsPrevious ? cache.text.slice(0, textStart) : ''}${translatedTail.text}`;

  cache.source = source;
  cache.text = text;
  cache.safeSourceEnd = sourceStart + translatedTail.safeSourceEnd;
  cache.safeTextEnd = textStart + translatedTail.safeTextEnd;
  return text;
}

export const MARKDOWN_MATH_PLUGINS = [{
  pattern: TOKEN_PATTERN,
  render: (match, key) => {
    const formula = decodeFormula(match[2] ?? '');
    if (match[1] === '2') return formula;
    const displayMode = match[1] === '1';
    const html = katex.renderToString(formula, {
      displayMode,
      output: 'htmlAndMathml',
      strict: 'warn',
      throwOnError: false,
      trust: false,
    });
    return (
      <span
        key={key}
        className={
          displayMode
            ? 'maka-math maka-math-display'
            : 'maka-math maka-math-inline'
        }
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  },
}] satisfies MarkdownInlinePlugin[];

const ZWSP = '\u200B';
const WORD_CHAR = /[\w$]/;

type TranslateMarkdownMathOptions = {
  startsAtLineStart?: boolean;
  priorTextChar?: string;
  allowDisplayMath?: boolean;
  protectEscapedBrackets?: boolean;
  isFinalSegment?: boolean;
  leadingBackslashes?: number;
  onLabelPending?: (state: LabelScanState) => void;
};

/**
 * Translate Maka's math delimiters into the upstream grammar and neutralize
 * bare `$` so prose never forms accidental inline math.
 *
 * Maka accepts `\(…\)` inline, `\[…\]` and `$$…$$` display math. Astryx parses
 * `$…$` inline and `$$…$$` blocks only, so the translation emits `$…$` for
 * inline math and newline-separated `$$` lines for display math. Every
 * remaining bare `$` outside code and link destinations is escaped so dollar
 * amounts, shell variables, and `$x$` prose stay literal; upstream's own
 * inline-math grammar only ever sees delimiters this transform emitted.
 */
function translateMarkdownMath(
  source: string,
  {
    startsAtLineStart = true,
    priorTextChar,
    allowDisplayMath = true,
    protectEscapedBrackets = false,
    isFinalSegment = false,
    leadingBackslashes = 0,
    onLabelPending,
  }: TranslateMarkdownMathOptions = {},
): {
  text: string;
  safeSourceEnd: number;
  safeTextEnd: number;
} {
  let text = '';
  let index = 0;
  let safeSourceEnd = 0;
  let safeTextEnd = 0;
  let atLineStart = startsAtLineStart;
  let canMarkSafe = true;
  const markSafe = () => {
    if (!canMarkSafe) return;
    safeSourceEnd = index;
    safeTextEnd = text.length;
  };

  while (index < source.length) {
    const fence = atLineStart ? readFence(source, index) : undefined;
    if (fence?.kind === 'pending') {
      text += source.slice(index);
      index = source.length;
      if (isFinalSegment) markSafe();
      break;
    }
    if (fence?.kind === 'match') {
      text += source.slice(index, fence.end);
      index = fence.end;
      atLineStart = source[index - 1] === '\n';
      if (fence.closed) markSafe();
      else break;
      continue;
    }

    // Hide escaped label brackets from both the math delimiter scan and the
    // Markdown bracket matcher, then restore them through the literal plugin.
    if (
      protectEscapedBrackets
      && source[index] === '\\'
      && (source[index + 1] === '[' || source[index + 1] === ']')
    ) {
      text += transportToken(source[index + 1] ?? '', '2');
      index += 2;
      atLineStart = false;
      markSafe();
      continue;
    }

    const literalToken = readLiteralToken(source, index);
    if (literalToken?.kind === 'pending') {
      text += source.slice(index);
      index = source.length;
      if (isFinalSegment) markSafe();
      break;
    }
    if (literalToken?.kind === 'match') {
      text += transportToken(literalToken.source, '2');
      index = literalToken.end;
      atLineStart = false;
      markSafe();
      continue;
    }

    if (source[index] === '`') {
      let runEnd = index + 1;
      while (source[runEnd] === '`') runEnd++;
      const run = source.slice(index, runEnd);
      const close = source.indexOf(run, runEnd);
      if (close < 0) {
        text += run;
        index = runEnd;
        atLineStart = false;
        if (isFinalSegment) {
          markSafe();
        } else {
          canMarkSafe = false;
        }
        continue;
      }
      const end = close + run.length;
      text += source.slice(index, end);
      index = end;
      atLineStart = source[index - 1] === '\n';
      markSafe();
      continue;
    }

    const link = readMarkdownLink(source, index, leadingBackslashes);
    if (link?.kind === 'pending') {
      // Remember the scan only when everything before its opener already
      // settled: an earlier unresolved backtick or math opener must be
      // reparsed together with later chunks, and resuming just the label
      // would skip it forever.
      if (link.labelState !== undefined && safeSourceEnd === index) {
        onLabelPending?.(link.labelState);
      }
      text += source.slice(index, link.end);
      index = link.end;
      atLineStart = false;
      if (isFinalSegment) {
        markSafe();
      } else {
        canMarkSafe = false;
      }
      continue;
    }
    if (link?.kind === 'match') {
      // A bare closed label with nothing after it can still grow an inline
      // or reference tail, so it must not settle: resuming after it would
      // scan that tail without the label context. Once any byte follows the
      // label the link question is decided and settling is safe again.
      const mayGrowTail = link.end === link.labelEnd + 1 && link.end >= source.length;
      // Display math renders as a block, which cannot live inside an inline
      // link label, and Markdown reads `\[` / `\]` there as literal escaped
      // brackets. Re-run every closed label with display math disabled so
      // escaped brackets survive for Markdown to unescape; inline math still
      // renders inside. Astryx decides later whether the label is an inline
      // link, reference use, shortcut, image, or definition, so all forms
      // must share this representation. Image alt text included:
      // Astryx keeps alt as a raw string, and the image component restores
      // literal tokens, so no private-use characters reach the DOM.
      const translatedLabel = translateMarkdownMath(source.slice(link.labelStart, link.labelEnd), {
        startsAtLineStart: false,
        priorTextChar: source[link.labelStart - 1],
        allowDisplayMath: false,
        protectEscapedBrackets: true,
        isFinalSegment: true,
      });
      // The explicit identifier of a full reference must go through the same
      // transform, or use-site and definition IDs diverge and the link breaks.
      let translatedRefText = '';
      let refSafe = true;
      if (link.refLabelStart !== undefined && link.refLabelEnd !== undefined) {
        const translatedRef = translateMarkdownMath(
          source.slice(link.refLabelStart, link.refLabelEnd),
          {
            startsAtLineStart: false,
            priorTextChar: source[link.refLabelStart - 1],
            allowDisplayMath: false,
            protectEscapedBrackets: true,
            isFinalSegment: true,
          },
        );
        translatedRefText = translatedRef.text;
        refSafe = translatedRef.safeSourceEnd >= link.refLabelEnd - link.refLabelStart;
      }
      const refStart = link.refLabelStart ?? link.end;
      const refEnd = link.refLabelEnd ?? link.end;
      text += source.slice(index, link.labelStart)
        + translatedLabel.text
        + source.slice(link.labelEnd, refStart)
        + translatedRefText
        + source.slice(refEnd, link.end);
      index = link.end;
      atLineStart = source[index - 1] === '\n';
      const labelSafe = translatedLabel.safeSourceEnd >= link.labelEnd - link.labelStart;
      if (labelSafe && refSafe && !mayGrowTail) {
        markSafe();
      } else {
        canMarkSafe = false;
      }
      continue;
    }

    // Destinations take `$` verbatim: escaping there would reach the href,
    // where `\$` does not round-trip back to `$`.
    const destination = readLinkDestination(source, index);
    if (destination !== undefined) {
      text += source.slice(index, destination);
      index = destination;
      atLineStart = false;
      markSafe();
      continue;
    }

    const autolink = readAutolink(source, index);
    if (autolink !== undefined) {
      text += source.slice(index, autolink);
      index = autolink;
      atLineStart = false;
      markSafe();
      continue;
    }

    const bareUrl = readBareUrl(source, index);
    if (bareUrl !== undefined) {
      text += source.slice(index, bareUrl);
      index = bareUrl;
      atLineStart = false;
      markSafe();
      continue;
    }

    const reference = atLineStart ? readReferenceDefinition(source, index) : undefined;
    if (reference !== undefined) {
      text += source.slice(index, reference);
      index = reference;
      markSafe();
      continue;
    }

    const delimited =
      readDelimitedMath(source, index, '\\(', '\\)', false)
      ?? (allowDisplayMath ? readDelimitedMath(source, index, '\\[', '\\]', true) : undefined)
      ?? (allowDisplayMath ? readDelimitedMath(source, index, '$$', '$$', true) : undefined);
    if (delimited?.kind === 'pending') {
      text += source.slice(index, delimited.end);
      index = delimited.end;
      atLineStart = false;
      if (isFinalSegment) {
        markSafe();
      } else {
        canMarkSafe = false;
      }
      continue;
    }
    if (delimited?.kind === 'match') {
      // A `$$`-line block would split a table row, so display math on a line
      // containing `|` degrades to an inline span inside the cell.
      const displayInline = delimited.display
        && !delimited.formula.includes('\n')
        && lineHasPipe(source, index);
      if (delimited.display && !displayInline) {
        text += displayMathSource(delimited.formula, source, index);
        index = delimited.end;
        atLineStart = source[index - 1] === '\n';
        markSafe();
        continue;
      }
      // At the source tail the character after the formula is unknown, so
      // the span stays uncommitted: the next chunk rescans from the opener
      // and decides the closing guard with the neighbor in hand.
      const next = source[delimited.end];
      if (isFinalSegment || next === undefined) markSafe();
      text += inlineMathSource(
        delimited.formula,
        text.length > 0 ? text[text.length - 1] : priorTextChar,
        next !== undefined && nextBreaksInlineClose(source, delimited.end),
      );
      index = delimited.end;
      atLineStart = source[index - 1] === '\n';
      if (isFinalSegment || next !== undefined) markSafe();
      continue;
    }

    const character = source[index] ?? '';
    if (character === '$' && !isEscaped(source, index, leadingBackslashes)) {
      text += '\\$';
    } else {
      text += character;
    }
    index++;
    atLineStart = character === '\n';
    if (
      isFinalSegment
      || index < source.length
      || (character !== '\\' && character !== '$' && character !== '`')
    ) {
      markSafe();
    }
  }

  return { text, safeSourceEnd, safeTextEnd };
}

/**
 * Emit upstream `$…$` for a `\(…\)` formula. A zero-width space separates a
 * delimiter from a neighbor that would trip upstream's guards — a digit or
 * `$` hugging either side makes the whole span literal — and a backslash
 * neighbor is doubled so it survives its own escape. The guards only exist
 * when the neighbor is actually hostile; an unconditional one would leave
 * invisible characters in copied text.
 */
function inlineMathSource(
  formula: string,
  previous: string | undefined,
  nextBreaksClose: boolean,
): string {
  const prefix = previous === '\\'
    ? '\\'
    : previous !== undefined && /[\d$]/.test(previous)
      ? ZWSP
      : '';
  return `${prefix}$${escapeFormulaDollars(formula)}$${nextBreaksClose ? ZWSP : ''}`;
}

/**
 * Whether the token at `index` emits a digit or a `$` — the only neighbors
 * that invalidate a just-emitted `$…$` closing delimiter. A pending `$$`
 * opener passes through raw, so it counts even before its closer arrives.
 */
function nextBreaksInlineClose(source: string, index: number): boolean {
  if (/\d/.test(source[index])) return true;
  const next =
    readDelimitedMath(source, index, '\\(', '\\)', false)
    ?? readDelimitedMath(source, index, '\\[', '\\]', true)
    ?? readDelimitedMath(source, index, '$$', '$$', true);
  if (!next) return false;
  if (next.kind === 'pending') return source[index] === '$';
  return !next.display || (!next.formula.includes('\n') && lineHasPipe(source, index));
}

/**
 * Escape bare `$` inside a formula so they cannot terminate the emitted
 * `$…$` early. A `$` already preceded by an odd run of backslashes is an
 * escaped dollar and stays `\$`.
 */
function escapeFormulaDollars(formula: string): string {
  let out = '';
  for (let i = 0; i < formula.length; i++) {
    if (formula[i] === '$' && !isEscaped(formula, i)) out += '\\';
    out += formula[i];
  }
  return out;
}

/** Whether the delimiter's enclosing source line contains a `|` — i.e. it may
 * be a table row that a `$$` line would split apart. */
function lineHasPipe(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = source.indexOf('\n', index);
  return source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).includes('|');
}

/**
 * Emit upstream `$$`-line display math. Each emitted line repeats the quote
 * and indentation context of the line the opener sat on, so `> \[…\]` and
 * `- \[…\]` stay inside their container. Newlines around the block split any
 * host paragraph; upstream only recognizes `$$` lines it owns outright.
 */
function displayMathSource(
  formula: string,
  source: string,
  index: number,
): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const quotePrefix = /^ {0,3}(?:> ?)*/.exec(source.slice(lineStart, index))?.[0] ?? '';
  const margin = quotePrefix + ' '.repeat(index - lineStart - quotePrefix.length);
  const body = formula.replaceAll('\n', `\n${margin}`);
  return `\n${margin}$$\n${margin}${body}\n${margin}$$\n${margin}`;
}

/**
 * Span of `](destination …)`/`![…](destination …)` and `][label]` reference
 * links. A destination ends at the `)` that returns paren depth to zero; an
 * unclosed one is prose and gets the ordinary `$` treatment.
 */
function readLinkDestination(source: string, index: number): number | undefined {
  if (source[index] !== ']') return undefined;
  if (source[index + 1] === '[') {
    const close = source.indexOf(']', index + 2);
    return close >= 0 && !source.slice(index + 2, close).includes('\n')
      ? close + 1
      : undefined;
  }
  if (source[index + 1] !== '(') return undefined;
  let depth = 0;
  for (let i = index + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') {
      i++;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) return i + 1;
    } else if (char === '\n' && depth === 1) {
      return undefined;
    }
  }
  return undefined;
}

/** `<scheme:…>` and `<address@host>` autolinks take `$` verbatim. */
function readAutolink(source: string, index: number): number | undefined {
  if (source[index] !== '<') return undefined;
  const match = /^<(?:[a-zA-Z][a-zA-Z0-9+.-]*:|[^<>\s@]+@[^<>\s@]+)[^<>\s]*>/.exec(
    source.slice(index),
  );
  return match ? index + match[0].length : undefined;
}

/**
 * Bare URLs and addresses that upstream autolinks (`https?://`, `www.`,
 * `mailto:`, `user@host.tld`), only when not continuing a word.
 */
function readBareUrl(source: string, index: number): number | undefined {
  const previous = source[index - 1];
  if (previous !== undefined && WORD_CHAR.test(previous)) return undefined;
  const match = /^(?:https?:\/\/|www\.|mailto:|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)\S*/.exec(
    source.slice(index),
  );
  return match ? index + match[0].length : undefined;
}

/** `[label]: destination` reference lines take `$` verbatim. */
function readReferenceDefinition(source: string, index: number): number | undefined {
  const match = /^ {0,3}\[[^\]\n]+\]:[^\n]*/.exec(source.slice(index));
  return match ? index + match[0].length : undefined;
}

function readFence(
  source: string,
  index: number,
):
  | { kind: 'match'; end: number; closed: boolean }
  | { kind: 'pending' }
  | undefined {
  const tail = source.slice(index);
  const opening = /^( {0,3})(`{3,}|~{3,})/.exec(tail);
  if (!opening) {
    return /^ {0,3}(?:`{1,2}|~{1,2})?$/.test(tail)
      ? { kind: 'pending' }
      : undefined;
  }
  const marker = opening[2] ?? '';
  let lineStart = source.indexOf('\n', index);
  while (lineStart >= 0) {
    lineStart++;
    const candidate = /^( {0,3})(`{3,}|~{3,})/.exec(source.slice(lineStart));
    const candidateMarker = candidate?.[2] ?? '';
    if (
      candidateMarker[0] === marker[0] &&
      candidateMarker.length >= marker.length
    ) {
      const lineEnd = source.indexOf('\n', lineStart);
      return {
        kind: 'match',
        end: lineEnd < 0 ? source.length : lineEnd + 1,
        closed: true,
      };
    }
    lineStart = source.indexOf('\n', lineStart);
  }
  return { kind: 'match', end: source.length, closed: false };
}

function readLiteralToken(
  source: string,
  index: number,
):
  | { kind: 'match'; source: string; end: number }
  | { kind: 'pending' }
  | undefined {
  if (source[index] !== TOKEN_START[0]) return undefined;
  if (!source.startsWith(TOKEN_START, index)) {
    const tail = source.slice(index);
    return tail.length < TOKEN_START.length && TOKEN_START.startsWith(tail)
      ? { kind: 'pending' }
      : undefined;
  }
  const tokenEnd = source.indexOf(TOKEN_END, index + TOKEN_START.length);
  if (tokenEnd < 0) {
    const payload = source.slice(index + TOKEN_START.length);
    return /^(?:[012](?::[0-9a-f]*)?)?$/.test(payload)
      ? { kind: 'pending' }
      : undefined;
  }
  const candidate = source.slice(index, tokenEnd + TOKEN_END.length);
  const match = LITERAL_TOKEN_PATTERN.exec(candidate);
  if (!match) return undefined;
  const token = match[0];
  return { kind: 'match', source: token, end: index + token.length };
}

function readDelimitedMath(
  source: string,
  index: number,
  opening: string,
  closing: string,
  allowNewlines: boolean,
):
  | { kind: 'match'; formula: string; display: boolean; end: number }
  | { kind: 'pending'; end: number }
  | undefined {
  if (!source.startsWith(opening, index)) return undefined;
  const contentStart = index + opening.length;
  const close = source.indexOf(closing, contentStart);

  if (close < 0) {
    if (!allowNewlines && source.indexOf('\n', contentStart) >= 0) return undefined;
    if (findPendingFenceBoundary(source, contentStart) >= 0) return undefined;
    return { kind: 'pending', end: contentStart };
  }
  const rawFormula = source.slice(contentStart, close);
  if (!allowNewlines && rawFormula.includes('\n')) return undefined;
  if (/(?:^|\n) {0,3}(?:`{3,}|~{3,})/.test(rawFormula)) {
    return undefined;
  }
  const formula = rawFormula.trim();
  if (formula === '') return undefined;
  // A `$` hugging an emitted inline delimiter trips upstream's `$$` guard and
  // leaves the span literal; display math takes lines verbatim instead.
  const display = closing !== '\\)';
  if (!display && (formula.startsWith('$') || formula.endsWith('$'))) {
    return undefined;
  }
  return { kind: 'match', formula, display, end: close + closing.length };
}

const MAX_LINK_LABEL_DEPTH = 32;
// NOTE: label scans deliberately have no length cap (tails keep theirs).
// Finding a close is linear, settling is permanent, and per-chunk rescan cost
// while a label is still open matches the base behaviour for unclosed math.
// Capping labels instead degrades complete long labels to literal text,
// which both breaks the link and pushes a giant literal run downstream that
// renders far slower than the structured link would have.
const MAX_LINK_TAIL_DEPTH = 32;
const MAX_LINK_TAIL_LENGTH = 65536;

type MarkdownLinkScan =
  | {
      kind: 'match';
      labelStart: number;
      labelEnd: number;
      end: number;
      refLabelStart?: number;
      refLabelEnd?: number;
    }
  | { kind: 'pending'; end: number; labelState?: LabelScanState }
  | undefined;

// Resume state for an unfinished first-label scan, keyed by the owning cache.
// Only the top-level scan stores here: nested scans re-derive on the next
// full pass, and any closure funnels through a full reprocess anyway.
const pendingLabelScans = new WeakMap<MarkdownMathCache, LabelScanState>();

/**
 * Recognize a bounded Markdown label starting at `index` so its contents can
 * be re-scanned without display math. Astryx resolves whether a closed label
 * is an inline link, reference use, shortcut, or definition after this pass;
 * treating all of them alike keeps reference identities stable.
 */
function readMarkdownLink(
  source: string,
  index: number,
  leadingBackslashes: number,
): MarkdownLinkScan {
  let openerEnd: number;
  if (source[index] === '!') {
    // A trailing `!` may yet become an image opener once `[` arrives; caching
    // it as safe would lose the `!` context and mistype the label as a link.
    if (index + 1 >= source.length) return { kind: 'pending', end: index + 1 };
    if (source[index + 1] !== '[') return undefined;
    if (isEscaped(source, index, leadingBackslashes)) return undefined;
    openerEnd = index + 2;
  } else if (source[index] === '[') {
    if (isEscaped(source, index, leadingBackslashes)) return undefined;
    openerEnd = index + 1;
  } else {
    return undefined;
  }

  const firstScan = scanLabel(source, initialLabelScanState(openerEnd));
  if (firstScan.kind === 'pending') {
    return { kind: 'pending', end: source.length, labelState: firstScan.state };
  }
  if (firstScan.kind === 'invalid') return { kind: 'pending', end: firstScan.end };
  const labelEnd = firstScan.end;

  const match = (end: number) => ({
    kind: 'match' as const,
    labelStart: openerEnd,
    labelEnd,
    end,
  });

  const tail = source[labelEnd + 1] ?? '';
  if (tail === '(') {
    const tailEnd = findInlineTailEnd(source, labelEnd + 1);
    if (tailEnd === 'pending') return { kind: 'pending', end: source.length };
    if (typeof tailEnd !== 'number') return match(tailEnd.end);
    return match(tailEnd);
  }
  if (tail === '[') {
    // The identifier scan resumes the same way the first label does: its
    // pending state is forwarded so streamed updates continue it instead of
    // restarting at the reference opener on every update. An invalid
    // identifier is definitive, so it keeps the old match-and-settle path.
    const refScan = scanLabel(source, initialLabelScanState(labelEnd + 2));
    if (refScan.kind === 'pending') {
      return { kind: 'pending', end: source.length, labelState: refScan.state };
    }
    if (refScan.kind === 'invalid') return match(refScan.end);
    return {
      ...match(refScan.end + 1),
      refLabelStart: labelEnd + 2,
      refLabelEnd: refScan.end,
    };
  }
  return match(labelEnd + 1);
}

function countPrecedingBackslashes(source: string, pos: number): number {
  let count = 0;
  let i = pos - 1;
  while (i >= 0 && source[i] === '\\') {
    count++;
    i--;
  }
  return count;
}

/** Whether the character at `pos` is backslash-escaped (odd run before it). */
function isEscaped(
  source: string,
  pos: number,
  leadingBackslashes = 0,
): boolean {
  let count = countPrecedingBackslashes(source, pos);
  if (pos - count === 0) count += leadingBackslashes;
  return count % 2 === 1;
}

/**
 * Resumable scan for the `]` closing a link label, skipping escapes, code
 * spans, and nested labels. Absolute positions stay valid across streaming
 * appends, so an unfinished scan can continue over new bytes instead of
 * re-walking from the opener on every update.
 */
type LabelScanState = {
  index: number;
  depth: number;
  escapeNext: boolean;
  checkBlank: boolean;
  runStart: number | null;
  codeDelimLen: number;
  codeSearchFrom: number;
};

function initialLabelScanState(from: number): LabelScanState {
  return {
    index: from,
    depth: 0,
    escapeNext: false,
    checkBlank: false,
    runStart: null,
    codeDelimLen: 0,
    codeSearchFrom: 0,
  };
}

type LabelScanResult =
  | { kind: 'pending'; state: LabelScanState }
  | { kind: 'closed'; end: number }
  | { kind: 'invalid'; end: number };

/**
 * Find the `]` closing a link label opened before `from`, skipping escapes,
 * code spans, and nested labels. Blank lines and excessive nesting can never
 * form a label here; running out of input means more text may still complete
 * it. There is deliberately no length bound: a close found anywhere resolves
 * and settles, so incomplete input is the only case that rescans per chunk.
 * Both the first label and reference identifiers scan through here, so a
 * pending second label resumes the same way the first one does.
 */
function scanLabel(source: string, st: LabelScanState): LabelScanResult {
  const pending = (): LabelScanResult => ({ kind: 'pending', state: st });
  while (st.index < source.length) {
    if (st.escapeNext) {
      // A trailing backslash left this pending; the pair only exists once the
      // escaped character has arrived. Skip both together, exactly as a fresh
      // scan would.
      if (st.index + 1 >= source.length) return pending();
      st.escapeNext = false;
      st.index += 2;
      continue;
    }
    if (st.checkBlank) {
      st.checkBlank = false;
      // The newline at st.index was already seen; only a second newline
      // makes it a blank line. Otherwise consume it as an ordinary char and
      // process the new character normally below.
      if (st.index + 1 >= source.length) {
        st.checkBlank = true;
        return pending();
      }
      if (source[st.index + 1] === '\n') return { kind: 'invalid', end: st.index };
      st.index++;
    }
    if (st.runStart !== null || source[st.index] === '`') {
      if (st.runStart === null) st.runStart = st.index;
      while (source[st.index] === '`') st.index++;
      if (st.index >= source.length) return pending();
      st.codeDelimLen = st.index - st.runStart;
      st.runStart = null;
      st.codeSearchFrom = st.index;
    }
    if (st.codeDelimLen > 0) {
      const close = source.indexOf('`'.repeat(st.codeDelimLen), st.codeSearchFrom);
      if (close < 0) {
        st.codeSearchFrom = Math.max(st.codeSearchFrom, source.length - (st.codeDelimLen - 1));
        return pending();
      }
      st.index = close + st.codeDelimLen;
      st.codeDelimLen = 0;
      st.codeSearchFrom = 0;
      continue;
    }
    const ch = source[st.index] ?? '';
    if (ch === '\n') {
      if (st.index + 1 >= source.length) {
        st.checkBlank = true;
        return pending();
      }
      if (source[st.index + 1] === '\n') return { kind: 'invalid', end: st.index };
      st.index++;
      continue;
    }
    if (ch === '\\') {
      if (st.index + 1 >= source.length) {
        st.escapeNext = true;
        return pending();
      }
      st.index += 2;
      continue;
    }
    if (ch === '[') {
      st.depth++;
      if (st.depth > MAX_LINK_LABEL_DEPTH) {
        return { kind: 'invalid', end: findInvalidLinkBoundary(source, st.index) };
      }
      st.index++;
      continue;
    }
    if (ch === ']') {
      if (st.depth === 0) return { kind: 'closed', end: st.index };
      st.depth--;
      st.index++;
      continue;
    }
    st.index++;
  }
  return pending();
}

/**
 * Find the end of an inline `(destination)` tail starting at its `(`. A
 * pending tail consumes the remaining source in one pass; resuming at the
 * opener would rescan the same suffix for every `[label](` in a stream.
 */
function findInlineTailEnd(
  source: string,
  from: number,
): number | 'pending' | { kind: 'invalid'; end: number } {
  let depth = 1;
  let i = from + 1;
  while (i < source.length) {
    if (i - from >= MAX_LINK_TAIL_LENGTH) {
      return { kind: 'invalid', end: findInvalidLinkBoundary(source, i) };
    }
    const ch = source[i] ?? '';
    if (ch === '\n' && source[i + 1] === '\n') return { kind: 'invalid', end: i };
    if (ch === '\\') {
      if (i + 1 >= source.length) return 'pending';
      i += 2;
      continue;
    }
    if (ch === '(') {
      depth++;
      if (depth > MAX_LINK_TAIL_DEPTH) {
        return { kind: 'invalid', end: findInvalidLinkBoundary(source, i) };
      }
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return 'pending';
}

function findInvalidLinkBoundary(source: string, from: number): number {
  const blankLine = source.indexOf('\n\n', from);
  return blankLine >= 0 ? blankLine : source.length;
}

function findPendingFenceBoundary(source: string, from: number): number {
  const fenceMatch = /(?:^|\n) {0,3}(?:`{3,}|~{3,})/g;
  fenceMatch.lastIndex = from;
  const fence = fenceMatch.exec(source);
  return fence ? fence.index + (source[fence.index] === '\n' ? 1 : 0) : -1;
}

function transportToken(value: string, kind: '0' | '1' | '2'): string {
  return `${TOKEN_START}${kind}:${encodeFormula(value)}${TOKEN_END}`;
}

const TRANSPORT_TOKEN_RESTORE_PATTERN = /\uE000MAKA_MATH:[012]:([0-9a-f]+)\uE001/g;

/**
 * Restore transport tokens in image alt text to plain text. Astryx keeps alt
 * as a raw string, so tokens that survive preprocessing would otherwise leak
 * private-use characters into the DOM. Literal tokens decode to their
 * characters; math tokens decode to their formula text, since KaTeX cannot
 * render inside an attribute.
 */
export function restoreTransportTokens(text: string): string {
  return text.replace(TRANSPORT_TOKEN_RESTORE_PATTERN, (_, encoded: string) =>
    decodeFormula(encoded),
  );
}

function encodeFormula(formula: string): string {
  let encoded = '';
  for (const byte of new TextEncoder().encode(formula)) {
    encoded += byte.toString(16).padStart(2, '0');
  }
  return encoded;
}

function decodeFormula(encoded: string): string {
  const bytes = new Uint8Array(encoded.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}
