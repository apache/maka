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

/**
 * Syntax colouring for the file-diff preview.
 *
 * The diff body used to paint every line one flat colour — green for an
 * addition, red for a deletion, grey for context — so a fifty-line hunk read
 * as three blocks of tint with no structure inside them. Astryx's `CodeBlock`
 * cannot supply the missing half: it highlights a whole buffer in one
 * language, and a diff is neither (its marker column is not code, and its
 * lines are two files interleaved).
 *
 * What Astryx does ship is the tokenizer underneath that component, and it
 * carries no state between lines: `tokenize` returns one token array per line,
 * each starting from that line's own offset with nothing inherited from the
 * one above. That is what a diff can use — the rows tokenize as one buffer of
 * stripped code and the results still line up row for row, with no pretence
 * that the old and new sides are each a compilable file.
 *
 * Stateless is not the same as line-bounded, and the difference is visible.
 * `tokenizeLine` bounds where a match may *start*, not how far it may run, and
 * several patterns span newlines — the JS block comment `/\*[\s\S]*?\*\/`, the
 * HTML `<!-- -->`, Python's triple-quoted strings. A row that opens one gets a
 * token reaching into the rows below (clamped where it is rendered), and those
 * rows, having inherited nothing, colour as ordinary code. So the interior of a
 * multi-line comment reads as code rather than as comment. That is a colour
 * being wrong, never a character: it is strictly better than the flat tint it
 * replaced, and fixing it means carrying an "inside a construct" flag across
 * rows here — a real feature, not a clamp, and not worth it until someone
 * misreads a diff because of it.
 *
 * The `astryx-token-*` classes the spans carry are Astryx's own span-mode
 * fallback classes, injected by `ensureHighlightStyles()`; the product's
 * `--color-syntax-*` theme tokens are what they resolve against.
 */

import { tokenize, type TokenLine } from '@astryxdesign/core';

/**
 * File extension → the language identifier Astryx's tokenizer knows. The table
 * is bounded by what `buildLanguagePatterns` implements, not by what Maka
 * happens to edit: anything else tokenizes to nothing and renders as plain
 * text, which is the result the diff had before and never a wrong colouring.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'svg',
  css: 'css',
  scss: 'scss',
  less: 'less',
  py: 'python',
  pyi: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'zsh',
  php: 'php',
  hh: 'hack',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
};

/**
 * Per-row tokens for a diff's stripped code, in row order — empty when the
 * paths do not agree on one language the tokenizer knows.
 *
 * Every producer of a `file_diff` result names exactly one path, so the
 * disagreement case is a guard rather than a feature: a diff spanning two
 * languages renders plain instead of taking whichever file came first.
 *
 * Joining the rows into one buffer is a way to make a single `tokenize` call,
 * not a claim that the buffer is valid source — the tokenizer returns one
 * entry per line and inherits no state from the line above (see the note on
 * newline-spanning patterns at the top of this file).
 */
export function diffSyntaxTokens(paths: readonly string[], code: readonly string[]): TokenLine[] {
  if (code.length === 0) return [];
  let language: string | undefined;
  for (const path of paths) {
    const candidate = syntaxLanguageForPath(path);
    if (candidate === undefined) return [];
    if (language !== undefined && language !== candidate) return [];
    language = candidate;
  }
  return language === undefined ? [] : tokenize(code.join('\n'), language);
}

export function syntaxLanguageForPath(path: string): string | undefined {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return extension ? LANGUAGE_BY_EXTENSION[extension] : undefined;
}
