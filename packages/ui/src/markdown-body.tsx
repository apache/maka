/**
 * Heavy Markdown rendering pipeline, loaded on demand by `markdown.tsx`.
 *
 * Astryx owns parsing, GFM, typography, tables, task lists, code rendering,
 * highlighting, and copy feedback. Maka's Markdown layer keeps only the
 * product trust boundaries that a design-system component cannot know about:
 * eager display-layer redaction and the closed-world URL policy.
 *
 * The conversation owns stream pacing. This layer only applies Astryx's pure
 * incomplete-syntax repair before parsing; enabling `isStreaming` would add a
 * second text smoother. PR 8 transfers the wider streaming and scroll boundary.
 */

import { useContext, type ReactNode } from 'react';
import {
  Markdown as AstryxMarkdown,
  type MarkdownComponents,
} from '@astryxdesign/core/Markdown';
import { trimStreamingArtifacts } from '@astryxdesign/core/Markdown/utils';
import { Link as AstryxLink } from '@astryxdesign/core/Link';
import {
  isMakaUriCandidate,
  isSafeExternalScheme,
  parseMakaUri,
} from './maka-uri.js';
import { MakaUriContext } from './markdown.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

const MAKA_MARKDOWN_COMPONENTS = {
  link: MarkdownLink,
  image: MarkdownImage,
} satisfies Partial<MarkdownComponents>;

export function MarkdownBody(props: {
  text: string;
  streaming?: boolean;
  density?: 'default' | 'compact';
}) {
  const parseableText = props.streaming
    ? trimStreamingArtifacts(props.text)
    : props.text;
  const safeText = neutralizeUnsafeMarkdownImages(parseableText);

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
        density={props.density ?? 'default'}
        components={MAKA_MARKDOWN_COMPONENTS}
      >
        {safeText}
      </AstryxMarkdown>
    </div>
  );
}

function MarkdownImage(props: { src: string; alt: string }) {
  if (!isSafeMarkdownImageUrl(props.src)) return <span>[{props.alt}]</span>;
  // Astryx calls this component only for images inside a paragraph. The shared
  // reset makes bare images block-level, so preserve inline flow for badges and
  // sentence-level icons; the reset keeps max-width/height.
  return <img src={props.src} alt={props.alt} style={{ display: 'inline-block' }} />;
}

/**
 * Astryx delegates inline images to `components.image`, but its current
 * standalone-image branch renders a native `<img>` directly. Neutralize
 * unsafe direct-image syntax before parsing so both branches retain Maka's
 * existing closed URL allowlist. The scanner follows Astryx's image grammar
 * and leaves fenced/inline code unchanged.
 */
function neutralizeUnsafeMarkdownImages(source: string): string {
  let fence: string | null = null;
  return source
    .split('\n')
    .map((line) => {
      if (fence) {
        if (line.startsWith(fence)) fence = null;
        return line;
      }

      const fenceMatch = line.match(/^(`{3,}|~{3,})(\w*)/);
      if (fenceMatch) {
        fence = fenceMatch[1];
        return line;
      }

      return neutralizeUnsafeImagesInLine(line);
    })
    .join('\n');
}

function neutralizeUnsafeImagesInLine(line: string): string {
  let output = '';
  let cursor = 0;

  while (cursor < line.length) {
    if (line[cursor] === '`') {
      const tickCount = line[cursor + 1] === '`'
        ? line[cursor + 2] === '`' ? 3 : 2
        : 1;
      const delimiter = '`'.repeat(tickCount);
      const close = line.indexOf(delimiter, cursor + tickCount);
      if (close !== -1) {
        const end = close + tickCount;
        output += line.slice(cursor, end);
        cursor = end;
        continue;
      }
    }

    if (line[cursor] === '!' && line[cursor + 1] === '[') {
      const altClose = line.indexOf(']', cursor + 2);
      if (altClose !== -1 && line[altClose + 1] === '(') {
        const srcStart = altClose + 2;
        const srcClose = findClosingParen(line, srcStart);
        if (srcClose !== -1) {
          const src = line.slice(srcStart, srcClose);
          if (isSafeMarkdownImageUrl(src)) {
            output += line.slice(cursor, srcClose + 1);
          } else {
            output += `!\\[${line.slice(cursor + 2, srcClose + 1)}`;
          }
          cursor = srcClose + 1;
          continue;
        }
      }
    }

    output += line[cursor];
    cursor++;
  }

  return output;
}

function findClosingParen(text: string, start: number): number {
  let depth = 1;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '(') depth++;
    if (text[index] === ')' && --depth === 0) return index;
  }
  return -1;
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
        aria-label={copy.invalidInternalLink}
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
      aria-label={copy.unsafeLink}
    >
      {children}
    </span>
  );
}
