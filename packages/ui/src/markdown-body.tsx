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

import {
  useContext,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  Markdown as AstryxMarkdown,
  type MarkdownComponents,
} from '@astryxdesign/core/Markdown';
import { trimStreamingArtifacts } from '@astryxdesign/core/Markdown/utils';
import { Link as AstryxLink } from '@astryxdesign/core/Link';
import { Text as AstryxText } from '@astryxdesign/core/Text';
import { useAnnounce } from '@astryxdesign/core/hooks';
import { useTranslator } from '@astryxdesign/core/i18n';
import {
  isMakaUriCandidate,
  isSafeExternalScheme,
  parseMakaUri,
} from './maka-uri.js';
import {
  useClipboardCopyFeedback,
  type ClipboardCopyPhase,
} from './clipboard-feedback.js';
import { MakaUriContext } from './markdown.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

const MAKA_MARKDOWN_COMPONENTS = {
  link: MarkdownLink,
  image: MarkdownImage,
} satisfies Partial<MarkdownComponents>;

export function MarkdownBody(props: { text: string; streaming?: boolean }) {
  const parseableText = props.streaming
    ? trimStreamingArtifacts(props.text)
    : props.text;
  const safeText = neutralizeUnsafeMarkdownImages(parseableText);
  const copyFeedback = useClipboardCopyFeedback(1400, { redact: false });
  const copyPhase = copyFeedback.phaseFor('code');
  const translate = useTranslator();
  const activeCopyCleanupsRef = useRef(new Set<() => void>());
  useEffect(() => {
    const activeCopyCleanups = activeCopyCleanupsRef.current;
    return () => {
      for (const cleanup of activeCopyCleanups) cleanup();
      activeCopyCleanups.clear();
    };
  }, []);

  // Astryx 0.1.9 owns this button and the authoritative `code` value but
  // discards clipboard rejections. Wrap its next write without stopping the
  // event, so Astryx keeps its native success state while Maka observes errors.
  function handleClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('button');
    const codeBlock = button?.closest('pre.astryx-codeblock');
    if (
      !(button instanceof HTMLButtonElement)
      || !codeBlock
      || !event.currentTarget.contains(codeBlock)
    ) return;

    const clipboard = navigator.clipboard;
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      clipboard,
      'writeText',
    );
    const originalWrite = clipboard.writeText.bind(clipboard);
    let restored = false;
    let writeStarted = false;
    let operationActive = true;
    let cancelAnnouncementLocalization = () => {};

    function restoreWriteText() {
      if (restored) return;
      restored = true;
      if (originalDescriptor) {
        Object.defineProperty(clipboard, 'writeText', originalDescriptor);
      } else {
        Reflect.deleteProperty(clipboard, 'writeText');
      }
    }

    function cancelOperation() {
      if (!operationActive) return;
      operationActive = false;
      cancelAnnouncementLocalization();
      activeCopyCleanupsRef.current.delete(cancelOperation);
    }

    try {
      Object.defineProperty(clipboard, 'writeText', {
        configurable: true,
        value: async (text: string) => {
          writeStarted = true;
          restoreWriteText();
          const copied = await copyFeedback.attempt(
            'code',
            () => originalWrite(text),
          );
          if (!copied || !operationActive) {
            cancelOperation();
            throw new Error('Clipboard write failed');
          }
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(cancelOperation);
          });
        },
      });
      cancelAnnouncementLocalization = localizeNextAstryxCopyAnnouncement(
        translate('@astryx.codeBlock.copied'),
      );
      activeCopyCleanupsRef.current.add(cancelOperation);
      window.setTimeout(() => {
        restoreWriteText();
        if (!writeStarted) cancelOperation();
      }, 0);
    } catch {
      // If the browser forbids wrapping the method, keep Astryx's native path.
    }
  }

  return (
    <div
      data-maka-contract="markdown"
      // Migration-only identity wrapper. `display: contents` gives the
      // contract harness a stable declared subtree without adding a layout
      // box or interfering with Astryx's document root.
      style={{ display: 'contents' }}
      onClickCapture={handleClickCapture}
    >
      <AstryxMarkdown
        autolink="gfm"
        components={MAKA_MARKDOWN_COMPONENTS}
      >
        {safeText}
      </AstryxMarkdown>
      {copyPhase && <MarkdownCodeCopyStatus phase={copyPhase} />}
    </div>
  );
}

function localizeNextAstryxCopyAnnouncement(copiedLabel: string) {
  let active = true;
  function cancel() {
    if (!active) return;
    active = false;
    observer.disconnect();
  }
  const observer = new MutationObserver(() => {
    const liveRegion = document.querySelector<HTMLElement>(
      '[data-astryx-live-region="polite"]',
    );
    if (liveRegion?.textContent !== 'Copied') return;

    cancel();
    liveRegion.textContent = copiedLabel;
  });
  observer.observe(document.body, {
    characterData: true,
    childList: true,
    subtree: true,
  });
  return cancel;
}

function MarkdownCodeCopyStatus(props: { phase: ClipboardCopyPhase }) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const announce = useAnnounce();
  const label = props.phase === 'pending'
    ? copy.copyingCode
    : props.phase === 'copied'
      ? copy.copiedCode
      : copy.copyCodeFailed;
  useEffect(() => {
    if (props.phase === 'failed') announce(label);
  }, [announce, label, props.phase]);

  return (
    <AstryxText
      as="div"
      type="supporting"
      display="block"
      data-copy-feedback={props.phase}
    >
      {label}
    </AstryxText>
  );
}

function MarkdownImage(props: { src: string; alt: string }) {
  if (!isSafeMarkdownImageUrl(props.src)) return <span>[{props.alt}]</span>;
  // Astryx calls this component only for images inside a paragraph. Tailwind
  // preflight makes bare images block-level, so preserve the inline flow that
  // badges and sentence-level icons require; preflight keeps max-width/height.
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
