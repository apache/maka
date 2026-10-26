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
 * Heavy Markdown rendering pipeline, loaded on demand by `markdown.tsx`.
 *
 * Astryx owns parsing, GFM, typography, tables, task lists, code rendering,
 * default highlighting, and copy feedback. Maka adds missing code languages
 * through the existing tokenizer interface and keeps its product trust
 * boundaries: eager display-layer redaction and the closed-world URL policy.
 *
 * Astryx owns stream pacing and incremental parsing. Maka keeps only the
 * product-specific trust boundaries around that renderer.
 */

import { MarkdownImage, createMarkdownImagePlugins } from './markdown-image.js';
import { lazy, Suspense, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import {
  Markdown as AstryxMarkdown,
  type MarkdownComponents,
  type MarkdownAstNode,
  type MarkdownAstRoot,
} from '@astryxdesign/core/Markdown';
import { createMarkdownPlugin, type MarkdownExtensionNode } from '@astryxdesign/core/Markdown/plugins';
import { Link as AstryxLink } from '@astryxdesign/core/Link';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { useTranslator } from '@astryxdesign/core/i18n';
import { markdownCodeLanguagePlugin, useMarkdownCodeTokenizer } from './markdown-code-highlighting.js';
import {
  isMakaUriCandidate,
  isSafeExternalScheme,
  parseMakaUri,
} from './maka-uri.js';
import { MakaUriContext } from './markdown.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { MermaidDiagram } from './mermaid-diagram.js';
import {
  createMarkdownMathCache,
  MarkdownMath,
  prepareMarkdownMath,
} from './markdown-math.js';

import { SvgCodeSource } from './svg-code-source.js';

const SvgCodePreview = lazy(() => import('./svg-code-preview.js'));

const BASE_MARKDOWN_COMPONENTS = {
  link: MarkdownLink,
  image: MarkdownImage,
  math: MarkdownMath,
};

export const MAX_AUTOMATIC_MERMAID_DIAGRAMS = 3;
export const MAX_AUTOMATIC_MERMAID_SOURCE_LENGTH = 4_000;
export const MAX_AUTOMATIC_MERMAID_TOTAL_SOURCE_LENGTH = 8_000;
const CODE_BLOCK_COLLAPSIBLE_THRESHOLD = 10;
const DEFERRED_MERMAID_LANGUAGE = 'makamermaiddeferred';
const DEFERRED_SVG_LANGUAGE = 'makasvgdeferred';
export const MAX_AUTOMATIC_SVG_DIAGRAMS = 3;
export const MAX_AUTOMATIC_SVG_SOURCE_LENGTH = 64 * 1024;

/** Admit XML whose document element looks like SVG; the lazy sanitizer validates
 * the complete document before any preview bytes reach an image element. */
function isSvgXml(code: string): boolean {
  let offset = 0;
  const skipWhitespace = () => {
    while (offset < code.length && /\s/.test(code[offset]!)) offset++;
  };
  skipWhitespace();
  if (code.startsWith('<?xml', offset) && /\s/.test(code[offset + 5] ?? '')) {
    const end = code.indexOf('?>', offset + 5);
    if (end < 0) return false;
    offset = end + 2;
    skipWhitespace();
  }
  // Advance through each comment once; nested regex repetitions can backtrack
  // exponentially on a long comment-only XML block without an SVG root.
  while (code.startsWith('<!--', offset)) {
    const end = code.indexOf('-->', offset + 4);
    if (end < 0) return false;
    offset = end + 3;
    skipWhitespace();
  }
  return code.startsWith('<svg', offset) && /[\s/>]/.test(code[offset + 4] ?? '');
}

/** Budget actual code nodes in document order, including blockquotes and lists.
 * Source text stays unchanged, and streaming messages don't install this plugin. */
export const markdownDiagramPlugin = createMarkdownPlugin({
  name: 'maka-diagram-previews',
  apiVersion: 1,
  transform(document, context) {
    if (!/mermaid|svg/i.test(context.source)) return document;
    let svgCount = 0;
    let svgLength = 0;
    let mermaidCount = 0;
    let mermaidLength = 0;
    const rewrite = (node: MarkdownAstNode<MarkdownExtensionNode>): MarkdownAstNode<MarkdownExtensionNode> => {
      if (node.type === 'code') {
        const language = node.lang?.trim().toLowerCase();
        const svg = language === 'svg' || (language === 'xml' && isSvgXml(node.value));
        if (!svg && language !== 'mermaid') return node;
        const size = node.value.length;
        const withinBudget = svg
          ? size <= MAX_AUTOMATIC_SVG_SOURCE_LENGTH && svgCount < MAX_AUTOMATIC_SVG_DIAGRAMS
            && svgLength + size <= 2 * MAX_AUTOMATIC_SVG_SOURCE_LENGTH
          : size <= MAX_AUTOMATIC_MERMAID_SOURCE_LENGTH && mermaidCount < MAX_AUTOMATIC_MERMAID_DIAGRAMS
            && mermaidLength + size <= MAX_AUTOMATIC_MERMAID_TOTAL_SOURCE_LENGTH;
        if (withinBudget) {
          if (svg) { svgCount++; svgLength += size; }
          else { mermaidCount++; mermaidLength += size; }
        }
        const lang = svg
          ? withinBudget ? 'svg' : DEFERRED_SVG_LANGUAGE
          : withinBudget ? 'mermaid' : DEFERRED_MERMAID_LANGUAGE;
        return lang === node.lang ? node : { ...node, lang };
      }
      if (!('children' in node)) return node;
      const children = node.children.map(rewrite);
      return children.every((child, index) => child === node.children[index])
        ? node : { ...node, children } as MarkdownAstNode<MarkdownExtensionNode>;
    };
    return rewrite(document) as MarkdownAstRoot<MarkdownExtensionNode>;
  },
});

// Whether the prose (not code) of a markdown source is written in Han script.
// The document `lang` is the UI locale, which says nothing about what the
// model wrote, so the CSS that styles Han-specific runs (emphasis has no
// italic in Han faces) keys on this instead.
export function hasHanProse(source: string): boolean {
  const prose = source
    .replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n {0,3}\2[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  return /\p{Script=Han}/u.test(prose);
}

const MARKDOWN_COMPONENTS = {
  default: {
    ...BASE_MARKDOWN_COMPONENTS,
    code: MarkdownCodeDefault,
  },
  compact: {
    ...BASE_MARKDOWN_COMPONENTS,
    code: MarkdownCodeCompact,
  },
  streamingDefault: {
    ...BASE_MARKDOWN_COMPONENTS,
    code: MarkdownCodeStreamingDefault,
  },
  streamingCompact: {
    ...BASE_MARKDOWN_COMPONENTS,
    code: MarkdownCodeStreamingCompact,
  },
} satisfies Record<string, Partial<MarkdownComponents>>;

export function MarkdownBody(props: {
  text: string;
  imageDisplay?: 'image' | 'link';
  streaming?: boolean;
  settledText?: string;
  density?: 'default' | 'compact';
}) {
  const mathCache = useRef(createMarkdownMathCache());
  const transformMathSource = useCallback(
    (source: string) => prepareMarkdownMath(source, mathCache.current),
    [],
  );
  const plugins = useMemo(() => [
    markdownCodeLanguagePlugin,
    ...(props.streaming ? [] : [markdownDiagramPlugin]),
    ...createMarkdownImagePlugins(props.imageDisplay),
  ], [props.imageDisplay, props.streaming]);
  const density = props.density ?? 'default';
  const components = props.streaming
    ? density === 'compact'
      ? MARKDOWN_COMPONENTS.streamingCompact
      : MARKDOWN_COMPONENTS.streamingDefault
    : MARKDOWN_COMPONENTS[density];

  return (
    <div
      data-maka-contract="markdown"
      data-maka-script={hasHanProse(props.text) ? 'han' : undefined}
      // Migration-only identity wrapper. `display: contents` gives the
      // contract harness a stable declared subtree without adding a layout
      // box or interfering with Astryx's document root.
      style={{ display: 'contents' }}
    >
      <AstryxMarkdown
        autolink="gfm"
        // Markdown holds no reading measure; the container it lands in does.
        //
        // Astryx caps prose at 680px by default but renders a supplied
        // `components.code` bare — no spacing, no width, no alignment. Maka
        // always supplies one, so any container that leans on the default gets
        // prose at 680 and code blocks at whatever the container is: two right
        // edges, which is the defect this whole change exists to remove. One
        // authority per column, and it is the container.
        contentWidth="100%"
        // Chosen by the caller, and defaulting to document rhythm.
        //
        // The transcript passes `compact`: Astryx's default heading spacing
        // assumes a page with a handful of sections, while an agent turn
        // emits headings every few lines, so the default margins push each
        // one into its own visual slab. That is the same argument that
        // flattens transcript heading SIZES in styles/chat-message.css — and
        // that rule is scoped to `.maka-turn` precisely because the other
        // caller, the Daily Review panel, renders a report, which is a
        // document. Hardcoding `compact` here contradicted that scoping: the
        // review kept full heading sizes but got transcript block spacing,
        // the one combination neither half of the argument asks for.
        density={density}
        components={components}
        plugins={plugins}
        isStreaming={props.streaming}
        settledText={props.settledText}
        transformSource={transformMathSource}
      >
        {props.text}
      </AstryxMarkdown>
    </div>
  );
}

function MarkdownCodeDefault(props: { code: string; language?: string }) {
  return <MarkdownCode {...props} density="default" renderDiagrams />;
}

function MarkdownCodeCompact(props: { code: string; language?: string }) {
  return <MarkdownCode {...props} density="compact" renderDiagrams />;
}

function MarkdownCodeStreamingDefault(props: { code: string; language?: string }) {
  return <MarkdownCode {...props} density="default" renderDiagrams={false} streaming />;
}

function MarkdownCodeStreamingCompact(props: { code: string; language?: string }) {
  return <MarkdownCode {...props} density="compact" renderDiagrams={false} streaming />;
}

function MarkdownCode(props: {
  code: string;
  language?: string;
  density: 'default' | 'compact';
  renderDiagrams: boolean;
  streaming?: boolean;
}) {
  const t = useTranslator();
  const tokenizer = useMarkdownCodeTokenizer(props.code, props.language, props.streaming === true);
  const language = props.language?.trim().toLowerCase();
  if (props.renderDiagrams && (language === 'mermaid' || language === DEFERRED_MERMAID_LANGUAGE)) {
    return (
      <MermaidDiagram
        code={props.code}
        density={props.density}
        autoRender={language === 'mermaid'}
      />
    );
  }

  if (props.renderDiagrams && (language === 'svg' || language === DEFERRED_SVG_LANGUAGE)) {
    return <Suspense fallback={<SvgCodeSource code={props.code} />}><SvgCodePreview code={props.code} autoRender={language === 'svg'} /></Suspense>;
  }

  const codeLines = props.code.split('\n');
  if (codeLines.length > 1 && codeLines.at(-1) === '') codeLines.pop();
  const isSingleLine = codeLines.length === 1;
  const isCollapsible = codeLines.length >= CODE_BLOCK_COLLAPSIBLE_THRESHOLD;
  const hasLanguageLabel = Boolean(language && language !== 'plaintext');

  return (
    <div
      className={`maka-markdown-code maka-markdown-code-${props.density}`}
      data-maka-code-layout={isSingleLine ? 'single-line' : 'multi-line'}>
      <CodeBlock
        code={props.code}
        language={props.language}
        tokenizer={tokenizer}
        // Span highlighting avoids the higher CSS Highlight paint cost during
        // transcript scrolling, including when virtualized code blocks remount.
        highlightMode="spans"
        // Markdown fences are block content. Astryx defaults to fit-content
        // with a 400px floor, which leaves short-code fences visibly narrow
        // even when the surrounding transcript has room to stay readable.
        width="100%"
        // Astryx otherwise overlays the copy button on headerless plaintext.
        // An empty title enables its structural header; once that header becomes
        // a collapse button, give plaintext the same localized code label that
        // language fences already provide through their language label.
        title={isCollapsible && !hasLanguageLabel ? t('@astryx.codeBlock.code') : ''}
        isCollapsible
        collapsibleThreshold={CODE_BLOCK_COLLAPSIBLE_THRESHOLD}
      />
    </div>
  );
}

/**
 * Route internal Markdown navigation through Maka's typed allowlist. Invalid
 * internal destinations never fall through to the operating system, and
 * external links are limited to the three schemes Maka deliberately exposes.
 */
function MarkdownLink(props: { href: string; children: ReactNode }) {
  const { href, children } = props;
  const dispatch = useContext(MakaUriContext);
  const copy = getSharedUiCopy(useUiLocale()).markdown;

  if (isMakaUriCandidate(href)) {
    const dest = parseMakaUri(href);
    if (dest && dispatch) {
      return (
        <AstryxLink
          type="inherit"
          hasUnderline
          data-maka-uri-kind={dest.kind}
          onClick={() => dispatch(dest)}
        >
          {children}
        </AstryxLink>
      );
    }
    return (
      <span
        data-reason="internal-invalid"
        title={copy.invalidInternalLink}
      >
        {children}
      </span>
    );
  }

  if (isSafeExternalScheme(href)) {
    return (
      <AstryxLink
        href={href}
        type="inherit"
        hasUnderline
        isExternalLink
      >
        {children}
      </AstryxLink>
    );
  }
  return (
    <span
      data-reason="unsafe-scheme"
      title={copy.unsafeLink}
    >
      {children}
    </span>
  );
}
