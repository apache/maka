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

export interface PreparedMarkdownMath {
  text: string;
  settledText?: string;
  plugin: MarkdownInlinePlugin;
}

interface MathTokenValue {
  formula: string;
  displayMode: boolean;
}

export function prepareMarkdownMath(
  source: string,
  settledSource?: string,
): PreparedMarkdownMath {
  const registry = createMathTokenRegistry([source, settledSource]);
  return {
    text: protectMathOutsideCode(source, registry.register),
    ...(settledSource === undefined
      ? {}
      : { settledText: protectMathOutsideCode(settledSource, registry.register) }),
    plugin: {
      pattern: registry.pattern,
      render: (match, key) => {
        const value = registry.values.get(match[0]);
        if (!value) return match[0];
        const html = katex.renderToString(value.formula, {
          displayMode: value.displayMode,
          output: 'htmlAndMathml',
          strict: 'warn',
          throwOnError: false,
          trust: false,
        });
        return (
          <span
            key={key}
            className={
              value.displayMode ? 'maka-math maka-math-display' : 'maka-math maka-math-inline'
            }
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      },
    },
  };
}

function createMathTokenRegistry(sources: Array<string | undefined>): {
  pattern: RegExp;
  register: (formula: string, displayMode: boolean) => string;
  values: Map<string, MathTokenValue>;
} {
  let namespaceIndex = 0;
  let namespace = '';
  do {
    namespace = `\uE000MAKAMATH:${namespaceIndex}:`;
    namespaceIndex += 1;
  } while (sources.some((source) => source?.includes(namespace)));

  const tokenEnd = ':\uE001';
  const values = new Map<string, MathTokenValue>();
  const tokensByValue = new Map<string, string>();
  let nextTokenId = 0;
  return {
    pattern: new RegExp(`${escapeRegExp(namespace)}\\d+${escapeRegExp(tokenEnd)}`, 'g'),
    register: (formula, displayMode) => {
      const valueKey = JSON.stringify([displayMode, formula]);
      const existingToken = tokensByValue.get(valueKey);
      if (existingToken) return existingToken;

      const token = `${namespace}${nextTokenId}${tokenEnd}`;
      nextTokenId += 1;
      values.set(token, { formula, displayMode });
      tokensByValue.set(valueKey, token);
      return token;
    },
    values,
  };
}

function protectMathOutsideCode(
  source: string,
  register: (formula: string, displayMode: boolean) => string,
): string {
  const lines = source.split('\n');
  let fence: { character: string; length: number } | undefined;
  let proseLines: string[] = [];
  const protectedParts: string[] = [];

  const flushProse = () => {
    if (proseLines.length === 0) return;
    protectedParts.push(protectMathInProse(proseLines.join('\n'), register));
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

function protectMathInProse(
  source: string,
  register: (formula: string, displayMode: boolean) => string,
): string {
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
      ?? readDelimitedMath(source, index, '$$', '$$', true, true);
    if (delimited) {
      output += register(delimited.formula, delimited.displayMode);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
