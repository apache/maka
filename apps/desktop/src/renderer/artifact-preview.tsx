/**
 * Per-kind preview switcher for the ArtifactPane. Routes by `record.kind`
 * and renders:
 *
 *   - `file`  → plain text via `readText`, monospace `<pre>`
 *   - `diff`  → unified diff via `readText`, line-tagged for add/del/hunk
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
  ArtifactRecord,
  ArtifactTextReadResult,
} from '@maka/core';
import { cn, previewVariants, Spinner, useUiLocale } from '@maka/ui';
import { RegistryArtifactPreview } from './artifact-preview-registry-shell';
import { getArtifactCopy, type ArtifactCopy } from './locales/artifact-copy';

export function ArtifactPreview(props: { record: ArtifactRecord; onShowInFolder?: () => void }) {
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

function FilePreview(props: { record: ArtifactRecord; copy: ArtifactCopy }) {
  const result = useTextRead(props.record.id);
  if (result.state === 'loading') return <PreviewLoading label={props.copy.preview.loadingFile} />;
  if (!result.value.ok) return <TextFailureCard record={props.record} reason={result.value.reason} copy={props.copy} />;
  const text =
    props.record.source === 'tool_result_archive'
      ? prettyArchiveJson(result.value.text)
      : result.value.text;
  return <pre className="maka-artifact-preview-file maka-code">{text}</pre>;
}

function prettyArchiveJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function DiffPreview(props: { record: ArtifactRecord; copy: ArtifactCopy }) {
  const result = useTextRead(props.record.id);
  if (result.state === 'loading') return <PreviewLoading label={props.copy.preview.loadingDiff} />;
  if (!result.value.ok) return <TextFailureCard record={props.record} reason={result.value.reason} copy={props.copy} />;
  const lines = result.value.text.split('\n');
  return (
    <div className={cn('maka-artifact-preview-diff', previewVariants({ part: 'diff' }))} data-kind="file_diff">
      <pre className={previewVariants({ part: 'diff-body' })}>
        {lines.map((line, index) => (
          <span
            key={`${index}:${line.slice(0, 16)}`}
            className={previewVariants({ part: 'diff-line' })}
            data-line={diffLineKind(line)}
          >
            {line || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}

function diffLineKind(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'ctx' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

function HtmlPreview(props: { record: ArtifactRecord; copy: ArtifactCopy }) {
  const result = useTextRead(props.record.id);
  if (result.state === 'loading') return <PreviewLoading label={props.copy.preview.loadingHtml} />;
  if (!result.value.ok) return <TextFailureCard record={props.record} reason={result.value.reason} copy={props.copy} />;
  const srcdoc = result.value.text;
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

// ---- binary-backed previews ------------------------------------------------

// PR-UI-RENDER-3a — the previous `ImagePreview` component was
// replaced by `RegistryArtifactPreview` from
// `./artifact-preview-registry-shell`. The replacement adds the
// typed registry resolution (mime_match / ext_fallback / oversize /
// mime_disallowed / no_mime_no_ext), the L2 base64 cap, and the
// Unsupported card with conditional "在 Finder 中打开" CTA.

function PdfPreview(props: { record: ArtifactRecord; copy: ArtifactCopy }) {
  const result = useBinaryRead(props.record.id);
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
      <Spinner className="maka-artifact-preview-spinner" aria-hidden="true" role="presentation" />
      <span>{props.label}</span>
    </div>
  );
}

function TextFailureCard(props: { record: ArtifactRecord; reason: TextFailureReason; copy: ArtifactCopy }) {
  const { tone, title, description } = failureCopyText(props.record, props.reason, props.copy);
  return <FailureCard tone={tone} title={title} description={description} />;
}

function BinaryFailureCard(props: { record: ArtifactRecord; reason: BinaryFailureReason; copy: ArtifactCopy }) {
  const { tone, title, description } = failureCopyBinary(props.record, props.reason, props.copy);
  return <FailureCard tone={tone} title={title} description={description} />;
}

function FailureCard(props: {
  tone: 'destructive' | 'info';
  title: string;
  description: string;
}) {
  return (
    <div className="maka-artifact-preview-fail" data-tone={props.tone} role="status">
      <div className="maka-artifact-preview-fail-title">{props.title}</div>
      <p className="maka-artifact-preview-fail-body">{props.description}</p>
    </div>
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

function failureCopyText(record: ArtifactRecord, reason: TextFailureReason, copy: ArtifactCopy): FailureCopy {
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

function failureCopyBinary(record: ArtifactRecord, reason: BinaryFailureReason, copy: ArtifactCopy): FailureCopy {
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

function useTextRead(artifactId: string): AsyncReadState<ArtifactTextReadResult> {
  const [state, setState] = useState<AsyncReadState<ArtifactTextReadResult>>({
    state: 'loading',
  });
  useEffect(() => {
    let disposed = false;
    setState({ state: 'loading' });
    window.maka.artifacts
      .readText(artifactId)
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
  }, [artifactId]);
  return state;
}

function useBinaryRead(artifactId: string): AsyncReadState<ArtifactBinaryReadResult> {
  const [state, setState] = useState<AsyncReadState<ArtifactBinaryReadResult>>({
    state: 'loading',
  });
  useEffect(() => {
    let disposed = false;
    setState({ state: 'loading' });
    window.maka.artifacts
      .readBinary(artifactId)
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
  }, [artifactId]);
  return state;
}
