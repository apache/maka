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

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { ansi } from './tui-ansi.js';

type HighlightFormatter = (text: string) => string;

export type TuiSyntaxHighlightTheme = Readonly<Partial<Record<string, HighlightFormatter>>>;

const languages = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  powershell,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(languages)) {
  hljs.registerLanguage(name, language);
}

/**
 * Fence aliases are intentionally explicit. Unknown, blank, and plain-text
 * tags stay unhighlighted instead of invoking unreliable auto-detection.
 */
const languageAliases: Readonly<Record<string, keyof typeof languages>> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  'c++': 'cpp',
  cs: 'csharp',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  md: 'markdown',
  ps1: 'powershell',
  py: 'python',
  rs: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
};

const defaultTheme: TuiSyntaxHighlightTheme = {
  keyword: ansi.accent,
  built_in: ansi.yellow,
  literal: ansi.yellow,
  number: ansi.yellow,
  regexp: ansi.green,
  string: ansi.green,
  comment: ansi.dim,
  doctag: ansi.dim,
  meta: ansi.muted,
  function: ansi.accent,
  title: ansi.accent,
  class: ansi.accent,
  type: ansi.accent,
  tag: ansi.accent,
  name: ansi.accent,
  attr: ansi.yellow,
  attribute: ansi.yellow,
  variable: ansi.yellow,
  params: ansi.muted,
  operator: ansi.yellow,
  addition: ansi.green,
  deletion: ansi.red,
};

/**
 * Highlight a Markdown fence into independent terminal lines.
 *
 * The optional theme keeps token classification testable without assuming a
 * TTY. Production uses Maka's capability-aware ANSI functions, so NO_COLOR and
 * basic terminals inherit the same behavior as the rest of the TUI.
 */
export function highlightMarkdownCode(
  code: string,
  language?: string,
  theme: TuiSyntaxHighlightTheme = defaultTheme,
): string[] {
  const normalizedLanguage = normalizeLanguage(language);
  if (!normalizedLanguage) return code.split('\n');

  try {
    const html = hljs.highlight(code, {
      language: normalizedLanguage,
      ignoreIllegals: true,
    }).value;
    return renderHighlightedHtml(html, theme).split('\n');
  } catch {
    // Rendering a response must not fail because a grammar or theme failed.
    return code.split('\n');
  }
}

function normalizeLanguage(language: string | undefined): string | undefined {
  const requested = language?.trim().toLowerCase();
  if (!requested) return undefined;
  const normalized = languageAliases[requested] ?? requested;
  return Object.hasOwn(languages, normalized) ? normalized : undefined;
}

const HTML_TOKEN = /<span\b[^>]*>|<\/span>|&(?:amp|lt|gt|quot|apos|#(?:\d+|x[\da-f]+));/giu;

function renderHighlightedHtml(html: string, theme: TuiSyntaxHighlightTheme): string {
  const scopes: Array<string | undefined> = [];
  let output = '';
  let cursor = 0;

  for (const match of html.matchAll(HTML_TOKEN)) {
    const index = match.index;
    appendStyled(html.slice(cursor, index));
    const token = match[0];

    if (token.startsWith('<span')) {
      scopes.push(scopeFromSpan(token));
    } else if (token === '</span>') {
      scopes.pop();
    } else {
      appendStyled(decodeHtmlEntity(token));
    }
    cursor = index + token.length;
  }
  appendStyled(html.slice(cursor));
  return output;

  function appendStyled(text: string): void {
    if (!text) return;
    const formatter = activeFormatter(scopes, theme);
    if (!formatter) {
      output += text;
      return;
    }
    // Keep every rendered line self-contained. A multi-line comment must not
    // leave an ANSI style open across the array boundary consumed by pi-tui.
    output += text
      .split('\n')
      .map((line) => (line ? formatter(line) : ''))
      .join('\n');
  }
}

function scopeFromSpan(tag: string): string | undefined {
  const classes = /\bclass=(?:"([^"]*)"|'([^']*)')/u.exec(tag);
  return (classes?.[1] ?? classes?.[2])
    ?.split(/\s+/u)
    .find((className) => className.startsWith('hljs-'))
    ?.slice('hljs-'.length);
}

function activeFormatter(
  scopes: readonly (string | undefined)[],
  theme: TuiSyntaxHighlightTheme,
): HighlightFormatter | undefined {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index];
    if (!scope) continue;
    const [prefix] = scope.split(/[.-]/u);
    const formatter = theme[scope] ?? (prefix ? theme[prefix] : undefined);
    if (formatter) return formatter;
  }
  return theme.default;
}

function decodeHtmlEntity(entity: string): string {
  const body = entity.slice(1, -1);
  switch (body) {
    case 'amp':
      return '&';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    default: {
      const radix = body.slice(0, 2).toLowerCase() === '#x' ? 16 : 10;
      const digits = body.slice(radix === 16 ? 2 : 1);
      const codePoint = Number.parseInt(digits, radix);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
  }
}
