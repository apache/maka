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

// A lazy, data-only grammar bundle. Refractor does not highlight DOM elements;
// Astryx still owns rendering, source text, copy, and every syntax colour.
import { refractor } from 'refractor/core';
import c from 'refractor/c';
import cpp from 'refractor/cpp';
import csharp from 'refractor/csharp';
import go from 'refractor/go';
import java from 'refractor/java';
import rust from 'refractor/rust';
import sql from 'refractor/sql';
import type { SyntaxToken } from '@astryxdesign/core/CodeBlock';
import { extraCodeLanguage, MAX_EXTRA_CODE_LENGTH } from './markdown-code-highlighting.js';

for (const grammar of [c, cpp, csharp, go, java, rust, sql]) refractor.register(grammar);

const TYPE_BY_CLASS: Readonly<Record<string, string>> = {
  keyword: 'keyword', string: 'string', char: 'string', regex: 'string',
  'interpolation-string': 'string', comment: 'comment', number: 'number',
  function: 'function', macro: 'function', 'class-name': 'type', builtin: 'type',
  namespace: 'type', lifetime: 'type', type: 'type', tag: 'tag',
  property: 'property', operator: 'operator', constant: 'constant', boolean: 'constant',
  annotation: 'constant', punctuation: 'punctuation', variable: 'variable',
  preprocessor: 'keyword', directive: 'keyword', 'directive-hash': 'keyword',
};
const MAX_CACHE_ENTRIES = 32;
const MAX_CACHED_SOURCE_LENGTH = 100_000;
const cache = new Map<string, { length: number; tokens: SyntaxToken[] }>();
let cachedLength = 0;

/** Sorted, non-overlapping UTF-16 ranges, split at newlines for Astryx 0.6.x. */
export function tokenizeExtraCode(code: string, language: string): SyntaxToken[] {
  const canonical = extraCodeLanguage(language);
  if (!canonical || !code || code.length > MAX_EXTRA_CODE_LENGTH) return [];
  const key = `${canonical}\0${code}`;
  const previous = cache.get(key);
  if (previous) {
    cache.delete(key);
    cache.set(key, previous);
    return previous.tokens;
  }

  try {
    const tree = refractor.highlight(code, canonical);
    type Node = typeof tree.children[number];
    const stack: { node: Node; type?: string }[] = tree.children
      .map(node => ({ node })).reverse();
    const tokens: SyntaxToken[] = [];
    let offset = 0;
    while (stack.length > 0) {
      const entry = stack.pop();
      if (!entry) break;
      const { node } = entry;
      if (node.type === 'text') {
        // Fail closed if a grammar ever changes source text. Never render its HTML.
        if (!code.startsWith(node.value, offset)) return [];
        if (entry.type) appendRanges(tokens, node.value, offset, entry.type);
        offset += node.value.length;
      } else if (node.type === 'element') {
        let type = entry.type;
        const classes = node.properties.className;
        if (Array.isArray(classes)) {
          for (const name of classes) {
            if (typeof name === 'string' && Object.hasOwn(TYPE_BY_CLASS, name)) {
              type = TYPE_BY_CLASS[name];
              break;
            }
          }
        }
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          stack.push({ node: node.children[index]!, type });
        }
      } else return [];
    }
    if (offset !== code.length) return [];

    cache.set(key, { length: code.length, tokens });
    cachedLength += code.length;
    while (cache.size > MAX_CACHE_ENTRIES || cachedLength > MAX_CACHED_SOURCE_LENGTH) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cachedLength -= cache.get(oldest)!.length;
      cache.delete(oldest);
    }
    return tokens;
  } catch {
    return [];
  }
}

function appendRanges(tokens: SyntaxToken[], value: string, offset: number, type: string): void {
  let start = 0;
  while (start < value.length) {
    const newline = value.indexOf('\n', start);
    const end = newline < 0 ? value.length : newline;
    if (end > start) {
      const previous = tokens.at(-1);
      if (previous?.type === type && previous.end === offset + start) {
        previous.end = offset + end;
      } else tokens.push({ type, start: offset + start, end: offset + end });
    }
    start = end + 1;
  }
}
