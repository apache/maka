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
 * Discardable derived state owned by one MarkdownBody mount. Capacity is two
 * strings no larger than that component's currently displayed source and its
 * transport form; a rewrite resets both and unmounting drops the cache.
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
  // keeps the JavaScript lexer on the changing tail; it does not make the
  // full-string identity check itself incremental.
  const extendsPrevious = source.startsWith(cache.source);
  const sourceStart = extendsPrevious ? cache.safeSourceEnd : 0;
  const textStart = extendsPrevious ? cache.safeTextEnd : 0;
  const protectedTail = protectMarkdownMath(
    source.slice(sourceStart),
    sourceStart === 0 || source[sourceStart - 1] === '\n',
  );
  const text = `${extendsPrevious ? cache.text.slice(0, textStart) : ''}${protectedTail.text}`;

  cache.source = source;
  cache.text = text;
  cache.safeSourceEnd = sourceStart + protectedTail.safeSourceEnd;
  cache.safeTextEnd = textStart + protectedTail.safeTextEnd;
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
          displayMode ? 'maka-math maka-math-display' : 'maka-math maka-math-inline'
        }
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  },
}] satisfies MarkdownInlinePlugin[];

function protectMarkdownMath(
  source: string,
  startsAtLineStart = true,
  allowDisplayMath = true,
  protectEscapedBrackets = false,
  isFinalSegment = false,
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
      // A bounded nested substring is final: end-of-input uncertainty there
      // is literal text, so only streaming input stays unsettled here.
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

    const link = readMarkdownLink(source, index);
    if (link?.kind === 'pending') {
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
      // must share this transport representation. Image alt text included:
      // Astryx keeps alt as a raw string, and the image component below
      // restores literal tokens, so no private-use characters reach the DOM.
      const protectedLabel = protectMarkdownMath(
        source.slice(link.labelStart, link.labelEnd),
        false,
        false,
        true,
        true,
      );
      // The explicit identifier of a full reference must go through the same
      // transform, or use-site and definition IDs diverge and the link breaks.
      let protectedRefText = '';
      let refSafe = true;
      if (link.refLabelStart !== undefined && link.refLabelEnd !== undefined) {
        const protectedRef = protectMarkdownMath(
          source.slice(link.refLabelStart, link.refLabelEnd),
          false,
          false,
          true,
          true,
        );
        protectedRefText = protectedRef.text;
        refSafe = protectedRef.safeSourceEnd >= link.refLabelEnd - link.refLabelStart;
      }
      const refStart = link.refLabelStart ?? link.end;
      const refEnd = link.refLabelEnd ?? link.end;
      text += source.slice(index, link.labelStart)
        + protectedLabel.text
        + source.slice(link.labelEnd, refStart)
        + protectedRefText
        + source.slice(refEnd, link.end);
      index = link.end;
      atLineStart = source[index - 1] === '\n';
      const labelSafe = protectedLabel.safeSourceEnd >= link.labelEnd - link.labelStart;
      if (labelSafe && refSafe && !mayGrowTail) {
        markSafe();
      } else {
        canMarkSafe = false;
      }
      continue;
    }

    const inlineDelim = readDelimitedMath(source, index, '\\(', '\\)', false, false);
    if (inlineDelim?.kind === 'pending') {
      text += source.slice(index, inlineDelim.end);
      index = inlineDelim.end;
      atLineStart = false;
      if (isFinalSegment) {
        markSafe();
      } else {
        canMarkSafe = false;
      }
      continue;
    }
    if (inlineDelim?.kind === 'match') {
      text += mathToken(inlineDelim.formula, inlineDelim.displayMode);
      index = inlineDelim.end;
      atLineStart = false;
      markSafe();
      continue;
    }

    if (allowDisplayMath) {
      const displayDelim =
        readDelimitedMath(source, index, '\\[', '\\]', true, true)
        ?? readDelimitedMath(source, index, '$$', '$$', true, true);
      if (displayDelim?.kind === 'pending') {
        text += source.slice(index, displayDelim.end);
        index = displayDelim.end;
        atLineStart = false;
        if (isFinalSegment) {
          markSafe();
        } else {
          canMarkSafe = false;
        }
        continue;
      }
      if (displayDelim?.kind === 'match') {
        text += mathToken(displayDelim.formula, displayDelim.displayMode);
        index = displayDelim.end;
        atLineStart = false;
        markSafe();
        continue;
      }
    }

    const character = source[index] ?? '';
    text += character;
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
  displayMode: boolean,
  allowNewlines: boolean,
):
  | { kind: 'match'; formula: string; displayMode: boolean; end: number }
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
  return { kind: 'match', formula, displayMode, end: close + closing.length };
}

const MAX_LINK_LABEL_DEPTH = 32;
const MAX_LINK_LABEL_LENGTH = 4096;
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
  | { kind: 'pending'; end: number }
  | undefined;

/**
 * Recognize a bounded Markdown label starting at `index` so its contents can
 * be re-scanned without display math. Astryx resolves whether a closed label
 * is an inline link, reference use, shortcut, or definition after this pass;
 * treating all of them alike keeps reference identities stable.
 */
function readMarkdownLink(source: string, index: number): MarkdownLinkScan {
  let openerEnd: number;
  if (source[index] === '!') {
    // A trailing `!` may yet become an image opener once `[` arrives; caching
    // it as safe would lose the `!` context and mistype the label as a link.
    if (index + 1 >= source.length) return { kind: 'pending', end: index + 1 };
    if (source[index + 1] !== '[') return undefined;
    if (isEscaped(source, index)) return undefined;
    openerEnd = index + 2;
  } else if (source[index] === '[') {
    if (isEscaped(source, index)) return undefined;
    openerEnd = index + 1;
  } else {
    return undefined;
  }

  const labelEnd = findLabelEnd(source, openerEnd);
  if (labelEnd === 'pending') return { kind: 'pending', end: source.length };
  if (typeof labelEnd !== 'number') return { kind: 'pending', end: labelEnd.end };

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
    const refEnd = findLabelEnd(source, labelEnd + 2);
    if (refEnd === 'pending') return { kind: 'pending', end: source.length };
    if (typeof refEnd !== 'number') return match(refEnd.end);
    return {
      ...match(refEnd + 1),
      refLabelStart: labelEnd + 2,
      refLabelEnd: refEnd,
    };
  }
  return match(labelEnd + 1);
}

/** Whether the character at `pos` is backslash-escaped (odd run before it). */
function isEscaped(source: string, pos: number): boolean {
  let count = 0;
  let i = pos - 1;
  while (i >= 0 && source[i] === '\\') {
    count++;
    i--;
  }
  return count % 2 === 1;
}

/**
 * Find the `]` closing a link label opened before `from`, skipping escapes,
 * code spans, and nested labels. Blank lines and excessive nesting can never
 * form a label; running out of input means more text may still complete it.
 */
function findLabelEnd(
  source: string,
  from: number,
): number | 'pending' | { kind: 'invalid'; end: number } {
  let depth = 0;
  let i = from;
  while (i < source.length) {
    if (i - from >= MAX_LINK_LABEL_LENGTH) {
      return { kind: 'invalid', end: findInvalidLinkBoundary(source, i) };
    }
    const ch = source[i] ?? '';
    if (ch === '\n' && source[i + 1] === '\n') return { kind: 'invalid', end: i };
    if (ch === '\\') {
      if (i + 1 >= source.length) return 'pending';
      i += 2;
      continue;
    }
    if (ch === '`') {
      let runEnd = i + 1;
      while (source[runEnd] === '`') runEnd++;
      const close = source.indexOf(source.slice(i, runEnd), runEnd);
      if (close < 0) return 'pending';
      i = close + (runEnd - i);
      continue;
    }
    if (ch === '[') {
      depth++;
      if (depth > MAX_LINK_LABEL_DEPTH) {
        return { kind: 'invalid', end: findInvalidLinkBoundary(source, i) };
      }
      i++;
      continue;
    }
    if (ch === ']') {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return 'pending';
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

function mathToken(formula: string, displayMode: boolean): string {
  return transportToken(formula, displayMode ? '1' : '0');
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
