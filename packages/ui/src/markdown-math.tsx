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

const TOKEN_START = '\uE000MAKAMATH';
const TOKEN_END = 'END\uE001';
const TOKEN_PATTERN = new RegExp(`${TOKEN_START}([ID])([0-9A-F]+)${TOKEN_END}`, 'g');

export interface PreparedMarkdownMath {
  text: string;
  plugin: MarkdownInlinePlugin;
}

export function prepareMarkdownMath(source: string): PreparedMarkdownMath {
  return {
    text: protectMathOutsideCode(source),
    plugin: {
      pattern: TOKEN_PATTERN,
      render: (match, key) => {
        const displayMode = match[1] === 'D';
        const formula = decodeFormula(match[2] ?? '');
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
            className={displayMode ? 'maka-math maka-math-display' : 'maka-math maka-math-inline'}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      },
    },
  };
}

function protectMathOutsideCode(source: string): string {
  const lines = source.split('\n');
  let fence: { character: string; length: number } | undefined;
  let proseLines: string[] = [];
  const protectedParts: string[] = [];

  const flushProse = () => {
    if (proseLines.length === 0) return;
    protectedParts.push(protectMathInProse(proseLines.join('\n')));
    proseLines = [];
  };

  for (const line of lines) {
    const opening = /^( {0,3})(`{3,}|~{3,})/.exec(line);
    if (opening) {
      flushProse();
      const marker = opening[2] ?? '';
      const character = marker[0] ?? '';
      if (!fence) {
        fence = { character, length: marker.length };
      } else if (character === fence.character && marker.length >= fence.length) {
        fence = undefined;
      }
      protectedParts.push(line);
    } else if (fence) {
      protectedParts.push(line);
    } else {
      proseLines.push(line);
    }
  }
  flushProse();

  return protectedParts.join('\n');
}

function protectMathInProse(source: string): string {
  let output = '';
  let index = 0;

  while (index < source.length) {
    if (source[index] === '`') {
      const run = /^`+/.exec(source.slice(index))?.[0] ?? '`';
      const close = source.indexOf(run, index + run.length);
      if (close >= 0) {
        output += source.slice(index, close + run.length);
        index = close + run.length;
        continue;
      }
    }

    const delimited =
      readDelimitedMath(source, index, '\\(', '\\)', false, false)
      ?? readDelimitedMath(source, index, '\\[', '\\]', true, true)
      ?? readDelimitedMath(source, index, '$$', '$$', true, true)
      ?? readDollarMath(source, index);
    if (delimited) {
      output += mathToken(delimited.formula, delimited.displayMode);
      index = delimited.end;
      continue;
    }

    output += source[index];
    index += 1;
  }

  return output;
}

function readDelimitedMath(
  line: string,
  index: number,
  opening: string,
  closing: string,
  displayMode: boolean,
  allowNewlines: boolean,
): { formula: string; displayMode: boolean; end: number } | undefined {
  if (!line.startsWith(opening, index)) return undefined;
  const contentStart = index + opening.length;
  const close = line.indexOf(closing, contentStart);
  if (close < 0) return undefined;
  if (!allowNewlines && line.slice(contentStart, close).includes('\n')) return undefined;
  const formula = line.slice(contentStart, close).trim();
  if (!formula) return undefined;
  return { formula, displayMode, end: close + closing.length };
}

function readDollarMath(
  line: string,
  index: number,
): { formula: string; displayMode: false; end: number } | undefined {
  if (line[index] !== '$' || line[index - 1] === '\\' || line[index + 1] === '$') {
    return undefined;
  }
  const lineEnd = line.indexOf('\n', index + 1);
  const close = findClosingDollar(line, index + 1, lineEnd < 0 ? line.length : lineEnd);
  if (close < 0) return undefined;
  const formula = line.slice(index + 1, close);
  if (!formula || /^\s|\s$/.test(formula)) return undefined;
  if (isPairedCurrencyRange(line, index, close)) return undefined;
  return { formula, displayMode: false, end: close + 1 };
}

function isPairedCurrencyRange(line: string, opening: number, closing: number): boolean {
  return /\d/.test(line[opening + 1] ?? '') && /\d/.test(line[closing + 1] ?? '');
}

function findClosingDollar(line: string, start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if (line[index] !== '$' || line[index - 1] === '\\' || line[index + 1] === '$') continue;
    return index;
  }
  return -1;
}

function mathToken(formula: string, displayMode: boolean): string {
  const encoded = Array.from(formula, (character) =>
    (character.codePointAt(0) ?? 0).toString(16).padStart(6, '0').toUpperCase()
  ).join('');
  return `${TOKEN_START}${displayMode ? 'D' : 'I'}${encoded}${TOKEN_END}`;
}

function decodeFormula(encoded: string): string {
  let formula = '';
  for (let index = 0; index < encoded.length; index += 6) {
    formula += String.fromCodePoint(Number.parseInt(encoded.slice(index, index + 6), 16));
  }
  return formula;
}
