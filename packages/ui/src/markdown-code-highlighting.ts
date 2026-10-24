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

import { useEffect, useMemo, useState } from 'react';
import type { CodeBlockProps, SyntaxToken } from '@astryxdesign/core/CodeBlock';
import type { MarkdownAstNode, MarkdownAstRoot } from '@astryxdesign/core/Markdown';
import { createMarkdownPlugin } from '@astryxdesign/core/Markdown/plugins';

const EXTRA_LANGUAGES = {
  java: 'java',
  go: 'go',
  golang: 'go',
  rust: 'rust',
  rs: 'rust',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'csharp',
  'c#': 'csharp',
  cs: 'csharp',
  dotnet: 'csharp',
  sql: 'sql',
} as const;

export type ExtraCodeLanguage = typeof EXTRA_LANGUAGES[keyof typeof EXTRA_LANGUAGES];
// Custom Astryx tokenizers are synchronous and bypass its large-buffer scheduler.
// Bound that work; an oversized block keeps its complete source, without colours.
export const MAX_EXTRA_CODE_LENGTH = 20_000;
export const EXTRA_CODE_STREAM_DELAY_MS = 120;

export function extraCodeLanguage(language: string | undefined): ExtraCodeLanguage | undefined {
  const key = language?.trim().toLowerCase();
  return key && Object.hasOwn(EXTRA_LANGUAGES, key)
    ? EXTRA_LANGUAGES[key as keyof typeof EXTRA_LANGUAGES]
    : undefined;
}

// Normalize the canonical AST, not Markdown source or code contents. Astryx's
// released components.code projection otherwise reduces c++ and c# to c.
export const markdownCodeLanguagePlugin = createMarkdownPlugin({
  name: 'maka-code-languages',
  apiVersion: 1,
  transform(document) {
    const rewrite = (node: MarkdownAstNode): MarkdownAstNode => {
      if (node.type === 'code') {
        const language = extraCodeLanguage(node.lang ?? undefined);
        if (!language || language === node.lang) return node;
        return {
          type: 'code', lang: language, value: node.value, meta: node.meta,
          position: node.position, data: node.data,
        };
      }
      if (!('children' in node)) return node;
      const children = node.children.map(child => rewrite(child));
      return children.every((child, index) => child === node.children[index])
        ? node : { ...node, children } as MarkdownAstNode;
    };
    return rewrite(document) as MarkdownAstRoot;
  },
});

type ExtraTokenizer = typeof import('./markdown-code-tokenizer.js').tokenizeExtraCode;
let tokenizerPromise: Promise<ExtraTokenizer> | undefined;

function loadTokenizer(): Promise<ExtraTokenizer> {
  tokenizerPromise ??= import('./markdown-code-tokenizer.js')
    .then(module => module.tokenizeExtraCode)
    .catch(error => {
      tokenizerPromise = undefined;
      throw error;
    });
  return tokenizerPromise;
}

/** Adapt prepared tokens only: no grammar loading or expensive work in render. */
export function useMarkdownCodeTokenizer(
  code: string,
  language: string | undefined,
  streaming: boolean,
): CodeBlockProps['tokenizer'] {
  const canonical = extraCodeLanguage(language);
  const eligible = canonical !== undefined && code.length > 0 && code.length <= MAX_EXTRA_CODE_LENGTH;
  const [result, setResult] = useState<{
    code: string;
    language: ExtraCodeLanguage;
    tokens: SyntaxToken[];
  }>();

  useEffect(() => {
    if (!eligible || !canonical) return;
    let active = true;
    let computeTimer: ReturnType<typeof setTimeout> | undefined;
    const loadTimer = setTimeout(() => {
      void loadTokenizer().then(tokenize => {
        if (!active) return;
        // Each block gets its own task even when many await one shared import.
        computeTimer = setTimeout(() => {
          if (!active) return;
          const tokens = tokenize(code, canonical);
          if (active) setResult({ code, language: canonical, tokens });
        }, 0);
      }).catch(() => {
        // Loading is optional: keep Astryx's readable plain-code fallback.
      });
    }, streaming ? EXTRA_CODE_STREAM_DELAY_MS : 0);
    return () => {
      active = false;
      clearTimeout(loadTimer);
      clearTimeout(computeTimer);
    };
  }, [code, canonical, eligible, streaming]);

  return useMemo(() => {
    if (!eligible || result?.code !== code || result.language !== canonical) return undefined;
    return (source, requestedLanguage) => source === result.code
      && extraCodeLanguage(requestedLanguage) === result.language ? result.tokens : [];
  }, [canonical, code, eligible, result]);
}
