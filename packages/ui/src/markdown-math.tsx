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

function protectMarkdownMath(source: string, startsAtLineStart = true): {
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

    const literalToken = readLiteralToken(source, index);
    if (literalToken?.kind === 'pending') {
      text += source.slice(index);
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

    const delimited =
      readDelimitedMath(source, index, '\\(', '\\)', false, false)
      ?? readDelimitedMath(source, index, '\\[', '\\]', true, true)
      ?? readDelimitedMath(source, index, '$$', '$$', true, true);
    if (delimited?.kind === 'pending') {
      text += source.slice(index, delimited.end);
      index = delimited.end;
      atLineStart = false;
      canMarkSafe = false;
      continue;
    }
    if (delimited?.kind === 'match') {
      text += mathToken(delimited.formula, delimited.displayMode);
      index = delimited.end;
      atLineStart = false;
      markSafe();
      continue;
    }

    const character = source[index] ?? '';
    text += character;
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
