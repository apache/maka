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
 * Per-kind preview switcher for the ArtifactPane. Routes by `record.kind`
 * and renders:
 *
 *   - `file`  → bounded Astryx code or Maka Markdown preview
 *   - `diff`  → shared structural diff renderer with gutters and syntax
 *   - `html`  → sandboxed `<iframe srcdoc>` with `sandbox="allow-scripts"`
 *               (NO `allow-same-origin`, `allow-top-navigation`,
 *               `allow-popups`, `allow-forms`, `allow-modals`). External
 *               links are counted via regex on `srcdoc` and reported in a
 *               status bar above the iframe — `<a href>` clicks are silently
 *               blocked by the sandbox (no `allow-popups`), so we tell the
 *               user up-front rather than letting them think the link
 *               "doesn't work".
 *   - `image` → `readBinary` → `<img src="data:…">` (MIME sniffed in main)
 *   - `pdf`   → `readBinary` → `<embed type="application/pdf">` with a
 *               fallback `<p>` instructing the user to open in Finder when
 *               the embed plugin is unavailable.
 *
 * Failure modes come back as a small `FailureCard` so the user
 * always sees a Chinese-language explanation of *why* the preview is empty
 * instead of a blank surface:
 *
 *   - `not_found` / `read_failed` → destructive ("路径可能已被外部删除")
 *   - `not_allowed`               → destructive ("路径检查未通过")
 *   - `too_large`                 → info, includes byte count + Finder hint
 *   - `deleted`                   → info ("此 artifact 已删除")
 *   - `unsupported_mime`          → info, binary only
 *
 * No component in this file ever assembles an absolute path: every read
 * goes through `window.maka.artifacts.readText` / `readBinary`.
 */
import { useEffect, useState } from 'react';
import type {
  ArtifactBinaryReadResult,
  ArtifactDescriptor,
  ArtifactTextReadResult,
} from '@maka/core/artifacts';
import {
  Button,
  DiffCodePreview,
  MarkdownBody,
  formatBytes,
  syntaxLanguageForPath,
  useUiLocale,
} from '@maka/ui';
import { Banner } from '@astryxdesign/core/Banner';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Spinner } from '@astryxdesign/core/Spinner';
import { RegistryArtifactPreview } from './artifact-preview-registry-shell';
import { getArtifactCopy, type ArtifactCopy } from './locales/artifact-copy';

export function ArtifactPreview(props: { record: ArtifactDescriptor; onShowInFolder?: () => void }) {
  const { record, onShowInFolder } = props;
  const copy = getArtifactCopy(useUiLocale());
  switch (record.kind) {
    case 'file':
      return <FilePreview record={record} copy={copy} />;
    case 'diff':
      return <DiffPreview record={record} copy={copy} />;
    case 'html':
      return <HtmlPreview record={record} copy={copy} />;
    case 'image':
      // PR-UI-RENDER-3a: route image previews through the typed
      // registry shell so the resolution path (mime match / ext
      // fallback / oversize / mime_disallowed) is testable + the
      // Unsupported fallback is consistent. file/diff/html/pdf stay
      // on the legacy path until their PR-RENDER-3b/c/d/e gates
      // land.
      return <RegistryArtifactPreview record={record} onShowInFolder={onShowInFolder} />;
    case 'pdf':
      return <PdfPreview record={record} copy={copy} />;
  }
}

// ---- text-backed previews --------------------------------------------------

const TEXT_DISPLAY_LIMIT_BYTES = 256 * 1024;
const TEXT_HIGHLIGHT_LIMIT_BYTES = 64 * 1024;
const TEXT_HIGHLIGHT_LINE_LIMIT = 1_000;
const DIFF_LINE_LIMIT = 500;

function FilePreview(props: { record: ArtifactDescriptor; copy: ArtifactCopy }) {
  const result = useTextRead(props.record.sessionId, props.record.id);
  if (result.state === 'loading') return <PreviewLoading label={props.copy.preview.loadingFile} />;
  if (!result.value.ok) return <TextFailureCard record={props.record} reason={result.value.reason} copy={props.copy} />;
  const text =
    props.record.source === 'tool_result_archive' && result.value.text.length <= TEXT_DISPLAY_LIMIT_BYTES
      ? prettyArchiveJson(result.value.text)
      : result.value.text;
  return <TextFilePreview name={props.record.name} text={text} copy={props.copy} />;
}

function TextFilePreview(props: { name: string; text: string; copy: ArtifactCopy }) {
  const markdown = /\.(?:md|markdown)$/i.test(props.name);
  const [mode, setMode] = useState<'rendered' | 'source'>(markdown ? 'rendered' : 'source');
  const bounded = boundPreviewText(props.text);

  return (
    <div className="maka-artifact-preview-text" data-mode={mode}>
      {markdown && (
        <div className="maka-artifact-preview-mode-switch" role="group" aria-label={props.copy.pane.previewNamed(props.name)}>
          <Button
            variant={mode === 'rendered' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={mode === 'rendered'}
            onClick={() => setMode('rendered')}
            label={props.copy.preview.rendered}
          />
          <Button
            variant={mode === 'source' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={mode === 'source'}
            onClick={() => setMode('source')}
            label={props.copy.preview.source}
          />
        </div>
      )}
      {mode === 'rendered' ? (
        <div className="maka-artifact-preview-markdown">
          <MarkdownBody text={bounded.highlightedText} density="compact" />
        </div>
      ) : (
        <BoundedCodePreview name={props.name} bounded={bounded} />
      )}
      {mode === 'rendered' && bounded.hasPlainRemainder && (
        <PreviewLimitNote>{props.copy.preview.renderLimited(formatBytes(TEXT_HIGHLIGHT_LIMIT_BYTES), TEXT_HIGHLIGHT_LINE_LIMIT)}</PreviewLimitNote>
      )}
      {mode === 'source' && bounded.hasPlainRemainder && (
        <PreviewLimitNote>{props.copy.preview.highlightLimited(formatBytes(TEXT_HIGHLIGHT_LIMIT_BYTES), TEXT_HIGHLIGHT_LINE_LIMIT)}</PreviewLimitNote>
      )}
      {mode === 'source' && bounded.isDisplayTruncated && (
        <PreviewLimitNote>{props.copy.preview.previewLimited(formatBytes(TEXT_DISPLAY_LIMIT_BYTES))}</PreviewLimitNote>
      )}
    </div>
  );
}

function prettyArchiveJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function DiffPreview(props: { record: ArtifactDescriptor; copy: ArtifactCopy }) {
  const result = useTextRead(props.record.sessionId, props.record.id);
  if (result.state === 'loading') return <PreviewLoading label={props.copy.preview.loadingDiff} />;
  if (!result.value.ok) return <TextFailureCard record={props.record} reason={result.value.reason} copy={props.copy} />;
  const bounded = boundPreviewText(result.value.text);
  const capped = capPreviewLines(bounded.displayText, DIFF_LINE_LIMIT);
  const rendered = boundPreviewText(capped.text);
  return (
    <div className="maka-artifact-preview-diff" data-kind="file_diff">
      <DiffCodePreview diff={rendered.highlightedText} paths={[props.record.name]} />
      {rendered.plainRemainder && <pre className="maka-artifact-preview-plain-remainder maka-code">{rendered.plainRemainder}</pre>}
      {rendered.hasPlainRemainder && (
        <PreviewLimitNote>{props.copy.preview.highlightLimited(formatBytes(TEXT_HIGHLIGHT_LIMIT_BYTES), TEXT_HIGHLIGHT_LINE_LIMIT)}</PreviewLimitNote>
      )}
      {capped.hiddenLines > 0 && (
        <PreviewLimitNote>{props.copy.preview.diffLinesLimited(capped.hiddenLines)}</PreviewLimitNote>
      )}
      {bounded.isDisplayTruncated && (
        <PreviewLimitNote>{props.copy.preview.previewLimited(formatBytes(TEXT_DISPLAY_LIMIT_BYTES))}</PreviewLimitNote>
      )}
    </div>
  );
}

function HtmlPreview(props: { record: ArtifactDescriptor; copy: ArtifactCopy }) {
  const result = useTextRead(props.record.sessionId, props.record.id);
  if (result.state === 'loading') return <PreviewLoading label={props.copy.preview.loadingHtml} />;
  if (!result.value.ok) return <TextFailureCard record={props.record} reason={result.value.reason} copy={props.copy} />;
  const bounded = boundPreviewText(result.value.text);
  if (bounded.isDisplayTruncated) {
    return (
      <div className="maka-artifact-preview-text">
        <BoundedCodePreview name={props.record.name} bounded={bounded} />
        {bounded.hasPlainRemainder && (
          <PreviewLimitNote>{props.copy.preview.highlightLimited(formatBytes(TEXT_HIGHLIGHT_LIMIT_BYTES), TEXT_HIGHLIGHT_LINE_LIMIT)}</PreviewLimitNote>
        )}
        <PreviewLimitNote>{props.copy.preview.previewLimited(formatBytes(TEXT_DISPLAY_LIMIT_BYTES))}</PreviewLimitNote>
      </div>
    );
  }
  const srcdoc = bounded.displayText;
  // External links inside the sandboxed iframe (no
  // `allow-popups`) silently fail. We surface the count up-front so the user
  // isn't surprised when clicks do nothing. Regex deliberately permissive —
  // counts `<a … href=` regardless of whitespace / attribute order.
  const externalLinkCount = (srcdoc.match(/<a\s[^>]*href=/gi) ?? []).length;
  return (
    <div className="maka-artifact-preview-html">
      <div
        className="maka-artifact-preview-external-links-bar"
        // @kenji a11y gate #5: screen readers should announce "外链已禁用 · N
        // links" when the user lands on an HTML artifact. `role="status"`
        // plus `aria-live="polite"` makes the change get queued for AT
        // without interrupting whatever the user is currently doing.
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {props.copy.preview.externalLinks(externalLinkCount)}
      </div>
      <iframe
        className="maka-artifact-preview-html-iframe"
        title={props.copy.preview.frameTitle(props.record.name)}
        sandbox="allow-scripts"
        srcDoc={srcdoc}
      />
    </div>
  );
}

function BoundedCodePreview(props: { name: string; bounded: BoundedPreviewText }) {
  const language = syntaxLanguageForPath(props.name);
  return (
    <>
      <CodeBlock
        className="maka-artifact-preview-code"
        code={props.bounded.highlightedText}
        {...(language ? { language } : {})}
        hasLanguageLabel={Boolean(language)}
        hasLineNumbers
        hasCopyButton={false}
        width="100%"
        container="section"
      />
      {props.bounded.plainRemainder && (
        <pre className="maka-artifact-preview-plain-remainder maka-code">{props.bounded.plainRemainder}</pre>
      )}
    </>
  );
}

function PreviewLimitNote(props: { children: string }) {
  return <p className="maka-artifact-preview-limit" role="note">{props.children}</p>;
}

type BoundedPreviewText = {
  displayText: string;
  highlightedText: string;
  plainRemainder: string;
  hasPlainRemainder: boolean;
  isDisplayTruncated: boolean;
};

function boundPreviewText(text: string): BoundedPreviewText {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  const displayText = decoder.decode(utf8Prefix(bytes, TEXT_DISPLAY_LIMIT_BYTES));
  const highlightCandidate = decoder.decode(utf8Prefix(bytes, TEXT_HIGHLIGHT_LIMIT_BYTES));
  const lineBreak = highlightCandidate.lastIndexOf('\n');
  let highlightedText = bytes.length > TEXT_HIGHLIGHT_LIMIT_BYTES && lineBreak > 0
    ? highlightCandidate.slice(0, lineBreak + 1)
    : highlightCandidate;
  const highlightLines = highlightedText.split('\n');
  if (highlightLines.length > TEXT_HIGHLIGHT_LINE_LIMIT) {
    highlightedText = `${highlightLines.slice(0, TEXT_HIGHLIGHT_LINE_LIMIT).join('\n')}\n`;
  }
  const plainRemainder = displayText.slice(highlightedText.length);
  return {
    displayText,
    highlightedText,
    plainRemainder,
    hasPlainRemainder: plainRemainder.length > 0,
    isDisplayTruncated: bytes.length > TEXT_DISPLAY_LIMIT_BYTES,
  };
}

function utf8Prefix(bytes: Uint8Array, limit: number): Uint8Array {
  let end = Math.min(bytes.length, limit);
  if (end === bytes.length) return bytes;
  while (end > 0 && (bytes[end] ?? 0) >>> 6 === 0b10) end -= 1;
  return bytes.subarray(0, end);
}

function capPreviewLines(text: string, limit: number): { text: string; hiddenLines: number } {
  const lines = text.split('\n');
  if (lines.length <= limit) return { text, hiddenLines: 0 };
  return { text: lines.slice(0, limit).join('\n'), hiddenLines: lines.length - limit };
}

// ---- binary-backed previews ------------------------------------------------

// PR-UI-RENDER-3a — the previous `ImagePreview` component was
// replaced by `RegistryArtifactPreview` from
// `./artifact-preview-registry-shell`. The replacement adds the
// typed registry resolution (mime_match / ext_fallback / oversize /
// mime_disallowed / no_mime_no_ext), the L2 base64 cap, and the
// Unsupported card with conditional "在 Finder 中打开" CTA.

function PdfPreview(props: { record: ArtifactDescriptor; copy: ArtifactCopy }) {
  const result = useBinaryRead(props.record.sessionId, props.record.id);
  if (result.state === 'loading') return <PreviewLoading label={props.copy.preview.loadingPdf} />;
  if (!result.value.ok) return <BinaryFailureCard record={props.record} reason={result.value.reason} copy={props.copy} />;
  return (
    <div className="maka-artifact-preview-pdf">
      <embed
        type="application/pdf"
        src={`data:application/pdf;base64,${result.value.base64}`}
        width="100%"
        height="100%"
      />
      <p className="maka-artifact-preview-pdf-fallback">
        {props.copy.preview.pdfFallback}
      </p>
    </div>
  );
}

// ---- shared affordances ----------------------------------------------------

function PreviewLoading(props: { label: string }) {
  return (
    <div className="maka-artifact-preview-loading" role="status" aria-live="polite">
      <Spinner
        className="maka-artifact-preview-spinner"
        size="sm"
        aria-hidden="true"
        role="presentation"
      />
      <span>{props.label}</span>
    </div>
  );
}

function TextFailureCard(props: { record: ArtifactDescriptor; reason: TextFailureReason; copy: ArtifactCopy }) {
  const { tone, title, description } = failureCopyText(props.record, props.reason, props.copy);
  return <FailureCard tone={tone} title={title} description={description} />;
}

function BinaryFailureCard(props: { record: ArtifactDescriptor; reason: BinaryFailureReason; copy: ArtifactCopy }) {
  const { tone, title, description } = failureCopyBinary(props.record, props.reason, props.copy);
  return <FailureCard tone={tone} title={title} description={description} />;
}

function FailureCard(props: {
  tone: 'destructive' | 'info';
  title: string;
  description: string;
}) {
  return (
    <Banner
      className="maka-artifact-preview-fail"
      data-tone={props.tone}
      status={props.tone === 'destructive' ? 'error' : 'info'}
      role="status"
      title={props.title}
      description={props.description}
    />
  );
}

// ---- failure-reason → copy -------------------------------------------------

type TextFailureReason = Extract<ArtifactTextReadResult, { ok: false }>['reason'];
type BinaryFailureReason = Extract<ArtifactBinaryReadResult, { ok: false }>['reason'];

interface FailureCopy {
  tone: 'destructive' | 'info';
  title: string;
  description: string;
}

function failureCopyText(record: ArtifactDescriptor, reason: TextFailureReason, copy: ArtifactCopy): FailureCopy {
  switch (reason) {
    case 'not_found':
    case 'read_failed':
      return {
        tone: 'destructive',
        ...copy.preview.readFailed,
      };
    case 'not_allowed':
      return {
        tone: 'destructive',
        ...copy.preview.notAllowed,
      };
    case 'too_large':
      return {
        tone: 'info',
        ...copy.preview.tooLarge(record.sizeBytes),
      };
    case 'deleted':
      return {
        tone: 'info',
        ...copy.preview.deleted,
      };
  }
}

function failureCopyBinary(record: ArtifactDescriptor, reason: BinaryFailureReason, copy: ArtifactCopy): FailureCopy {
  if (reason === 'unsupported_mime') {
    return {
      tone: 'info',
      ...copy.preview.unsupportedMime,
    };
  }
  return failureCopyText(record, reason, copy);
}

// ---- read hooks ------------------------------------------------------------

type AsyncReadState<T> = { state: 'loading' } | { state: 'ready'; value: T };

function useTextRead(
  sessionId: string,
  artifactId: string,
): AsyncReadState<ArtifactTextReadResult> {
  const [state, setState] = useState<AsyncReadState<ArtifactTextReadResult>>({
    state: 'loading',
  });
  useEffect(() => {
    let disposed = false;
    setState({ state: 'loading' });
    window.maka.artifacts
      .readText(sessionId, artifactId)
      .then((value) => {
        if (!disposed) setState({ state: 'ready', value });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // Map IPC-level failures (preload throw, channel closed) onto the
        // contract enum so the FailureCard can render a consistent message
        // instead of leaking an Electron error string to the user.
        const message = error instanceof Error ? error.message : String(error);
        const reason: TextFailureReason = message.includes('not_allowed')
          ? 'not_allowed'
          : 'read_failed';
        setState({ state: 'ready', value: { ok: false, reason } });
      });
    return () => {
      disposed = true;
    };
  }, [artifactId, sessionId]);
  return state;
}

function useBinaryRead(
  sessionId: string,
  artifactId: string,
): AsyncReadState<ArtifactBinaryReadResult> {
  const [state, setState] = useState<AsyncReadState<ArtifactBinaryReadResult>>({
    state: 'loading',
  });
  useEffect(() => {
    let disposed = false;
    setState({ state: 'loading' });
    window.maka.artifacts
      .readBinary(sessionId, artifactId)
      .then((value) => {
        if (!disposed) setState({ state: 'ready', value });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        const reason: BinaryFailureReason = message.includes('not_allowed')
          ? 'not_allowed'
          : 'read_failed';
        setState({ state: 'ready', value: { ok: false, reason } });
      });
    return () => {
      disposed = true;
    };
  }, [artifactId, sessionId]);
  return state;
}
