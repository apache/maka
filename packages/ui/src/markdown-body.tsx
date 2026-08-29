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
 * highlighting, and copy feedback. Maka's Markdown layer keeps only the
 * product trust boundaries that a design-system component cannot know about:
 * eager display-layer redaction and the closed-world URL policy.
 *
 * Astryx owns stream pacing and incremental parsing. Maka keeps only the
 * product-specific trust boundaries around that renderer.
 */

import { useContext, type ReactNode } from 'react';
import {
  Markdown as AstryxMarkdown,
  type MarkdownComponents,
} from '@astryxdesign/core/Markdown';
import { Link as AstryxLink } from '@astryxdesign/core/Link';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { useTranslator } from '@astryxdesign/core/i18n';
import {
  isMakaUriCandidate,
  isSafeExternalScheme,
  parseMakaUri,
} from './maka-uri.js';
import { MakaUriContext } from './markdown.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { MermaidDiagram } from './mermaid-diagram.js';
import { prepareMarkdownMath } from './markdown-math.js';
import { parseAttachmentResourceRef } from '@maka/core/attachments';
import { useAttachmentImageSource } from './attachment-image.js';

const BASE_MARKDOWN_COMPONENTS = {
  link: MarkdownLink,
  image: MarkdownImage,
};

export const MAX_AUTOMATIC_MERMAID_DIAGRAMS = 3;
export const MAX_AUTOMATIC_MERMAID_SOURCE_LENGTH = 4_000;
export const MAX_AUTOMATIC_MERMAID_TOTAL_SOURCE_LENGTH = 8_000;
const CODE_BLOCK_COLLAPSIBLE_THRESHOLD = 10;
const DEFERRED_MERMAID_LANGUAGE = 'makamermaiddeferred';

/**
 * Mark settled Mermaid fences that exceed the per-document automatic-render
 * budget. The private language marker survives Astryx parsing without changing
 * the source shown to the user; the code renderer turns it into an explicit
 * source + Render action instead of scheduling more main-thread layout work.
 */
export function applyMermaidRenderBudget(source: string): string {
  const lines = source.split('\n');
  let automaticCount = 0;
  let automaticSourceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/.exec(lines[index] ?? '');
    if (!opening) continue;
    const [, indent = '', fence = '', info = ''] = opening;
    const language = /^([ \t]*)mermaid(?=[ \t]|$)/i.exec(info);
    if (!language) continue;

    const fenceCharacter = fence[0];
    if (!fenceCharacter) continue;
    const closing = new RegExp(`^ {0,3}${fenceCharacter}{${fence.length},}[ \\t]*$`);
    let closingIndex = index + 1;
    while (closingIndex < lines.length && !closing.test(lines[closingIndex] ?? '')) {
      closingIndex += 1;
    }
    if (closingIndex >= lines.length) continue;

    const codeLength = lines.slice(index + 1, closingIndex).join('\n').length;
    const withinBudget =
      codeLength <= MAX_AUTOMATIC_MERMAID_SOURCE_LENGTH
      && automaticCount < MAX_AUTOMATIC_MERMAID_DIAGRAMS
      && automaticSourceLength + codeLength <= MAX_AUTOMATIC_MERMAID_TOTAL_SOURCE_LENGTH;

    if (withinBudget) {
      automaticCount += 1;
      automaticSourceLength += codeLength;
    } else {
      const leadingWhitespace = language[1] ?? '';
      lines[index] = `${indent}${fence}${leadingWhitespace}${DEFERRED_MERMAID_LANGUAGE}${info.slice(language[0].length)}`;
    }
    index = closingIndex;
  }

  return lines.join('\n');
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
  streaming?: boolean;
  settledText?: string;
  density?: 'default' | 'compact';
}) {
  const prepared = prepareMarkdownMath(props.text, props.settledText);
  const safeText = prepared.text;
  const budgetedText = props.streaming ? safeText : applyMermaidRenderBudget(safeText);
  const density = props.density ?? 'default';
  const components = props.streaming
    ? density === 'compact'
      ? MARKDOWN_COMPONENTS.streamingCompact
      : MARKDOWN_COMPONENTS.streamingDefault
    : MARKDOWN_COMPONENTS[density];

  return (
    <div
      data-maka-contract="markdown"
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
        inlinePlugins={[prepared.plugin]}
        isStreaming={props.streaming}
        settledText={prepared.settledText}
      >
        {budgetedText}
      </AstryxMarkdown>
    </div>
  );
}

function MarkdownCodeDefault(props: { code: string; language?: string }) {
  return <MarkdownCode {...props} density="default" renderMermaid />;
}

function MarkdownCodeCompact(props: { code: string; language?: string }) {
  return <MarkdownCode {...props} density="compact" renderMermaid />;
}

function MarkdownCodeStreamingDefault(props: { code: string; language?: string }) {
  return <MarkdownCode {...props} density="default" renderMermaid={false} />;
}

function MarkdownCodeStreamingCompact(props: { code: string; language?: string }) {
  return <MarkdownCode {...props} density="compact" renderMermaid={false} />;
}

function MarkdownCode(props: {
  code: string;
  language?: string;
  density: 'default' | 'compact';
  renderMermaid: boolean;
}) {
  const t = useTranslator();
  const language = props.language?.trim().toLowerCase();
  if (props.renderMermaid && (language === 'mermaid' || language === DEFERRED_MERMAID_LANGUAGE)) {
    return (
      <MermaidDiagram
        code={props.code}
        density={props.density}
        autoRender={language === 'mermaid'}
      />
    );
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

function MarkdownImage(props: { src: string; alt: string }) {
  const attachment = parseAttachmentResourceRef(props.src);
  const attachmentSrc = useAttachmentImageSource(
    attachment ? { artifactId: attachment.artifactId } : undefined,
  );
  if (attachment) {
    if (!attachmentSrc) return <span>[{props.alt}]</span>;
    return (
      <img
        className="maka-markdown-attachment-image"
        src={attachmentSrc}
        alt={props.alt}
      />
    );
  }
  if (!isSafeMarkdownImageUrl(props.src)) return <span>[{props.alt}]</span>;
  // Remote images can be badges or sentence-level icons, so preserve Maka's
  // existing inline presentation. Session attachments above are content
  // previews and deliberately own a block presentation instead.
  return <img src={props.src} alt={props.alt} style={{ display: 'inline-block' }} />;
}

function isSafeMarkdownImageUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
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
