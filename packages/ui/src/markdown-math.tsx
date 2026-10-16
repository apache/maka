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
  const sourceStart = extendsPrevious ? cache.safeSourceEnd : 0;
  const textStart = extendsPrevious ? cache.safeTextEnd : 0;
  const translatedTail = translateMarkdownMath(
    source.slice(sourceStart),
    sourceStart === 0 || source[sourceStart - 1] === '\n',
    cache.text[textStart - 1],
  );
  const text = `${extendsPrevious ? cache.text.slice(0, textStart) : ''}${translatedTail.text}`;

  cache.source = source;
  cache.text = text;
  cache.safeSourceEnd = sourceStart + translatedTail.safeSourceEnd;
  cache.safeTextEnd = textStart + translatedTail.safeTextEnd;
  return text;
}

const ZWSP = '\u200B';
const WORD_CHAR = /[\w$]/;

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
  startsAtLineStart = true,
  priorTextChar?: string,
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

    if (source[index] === '`') {
      let runEnd = index + 1;
      while (source[runEnd] === '`') runEnd++;
      const run = source.slice(index, runEnd);
      const close = source.indexOf(run, runEnd);
      if (close < 0) {
        text += run;
        index = runEnd;
        atLineStart = false;
        canMarkSafe = false;
        continue;
      }
      const end = close + run.length;
      text += source.slice(index, end);
      index = end;
      atLineStart = source[index - 1] === '\n';
      markSafe();
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
      ?? readDelimitedMath(source, index, '\\[', '\\]', true)
      ?? readDelimitedMath(source, index, '$$', '$$', true);
    if (delimited?.kind === 'pending') {
      text += source.slice(index, delimited.end);
      index = delimited.end;
      atLineStart = false;
      canMarkSafe = false;
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
      if (next === undefined) markSafe();
      text += inlineMathSource(
        delimited.formula,
        text.length > 0 ? text[text.length - 1] : priorTextChar,
        next !== undefined && nextBreaksInlineClose(source, delimited.end),
      );
      index = delimited.end;
      atLineStart = source[index - 1] === '\n';
      if (next !== undefined) markSafe();
      continue;
    }

    const character = source[index] ?? '';
    if (character === '$' && !isEscaped(source, index)) {
      text += '\\$';
    } else {
      text += character;
    }
    index++;
    atLineStart = character === '\n';
    if (
      index < source.length ||
      (character !== '\\' && character !== '$' && character !== '`')
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

function findPendingFenceBoundary(source: string, from: number): number {
  const fenceMatch = /(?:^|\n) {0,3}(?:`{3,}|~{3,})/g;
  fenceMatch.lastIndex = from;
  const fence = fenceMatch.exec(source);
  return fence ? fence.index + (source[fence.index] === '\n' ? 1 : 0) : -1;
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  let i = index - 1;
  while (i >= 0 && source[i] === '\\') {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 1;
}
