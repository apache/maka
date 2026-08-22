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

/** Renderer shell for capped raster previews and typed unsupported outcomes. */

import { useEffect, useState } from 'react';
import type { ArtifactDescriptor } from '@maka/core/artifacts';
import { Button, useUiLocale } from '@maka/ui';
import { Banner } from '@astryxdesign/core/Banner';
import { Spinner } from '@astryxdesign/core/Spinner';
import {
  type ArtifactPreviewInput,
  type PreviewResolution,
  decideImageReadOutcome,
  formatPreviewSize,
  resolvePreviewKind,
} from '@maka/ui/artifact-preview-registry';
import { getArtifactCopy, type ArtifactCopy } from './locales/artifact-copy';

/**
 * Top-level dispatcher: classifies the record and renders the
 * appropriate component. The caller (currently
 * `artifact-preview.tsx`) only needs to call this for the `image`
 * record.kind; other kinds keep using the legacy preview switch.
 */
export function RegistryArtifactPreview(props: {
  record: ArtifactDescriptor;
  /** Optional: shows a real button when provided. Hidden otherwise. */
  onShowInFolder?: () => void;
}) {
  const input = toPreviewInput(props.record);
  const resolution = resolvePreviewKind(input);
  if (resolution.kind === 'image') {
    return <ImageArtifactPreview record={props.record} input={input} onShowInFolder={props.onShowInFolder} />;
  }
  return (
    <UnsupportedArtifactPreview
      input={input}
      reason={resolution.reason}
      onShowInFolder={props.onShowInFolder}
    />
  );
}

/**
 * Reason → user-facing copy. Keyed by `PreviewResolution.reason`
 * (the unsupported variant only). Adding a new reason variant in
 * the registry pure module forces TypeScript exhaustiveness here.
 */
function describeUnsupportedReason(
  reason: Extract<PreviewResolution, { kind: 'unsupported' }>['reason'],
  copy: ArtifactCopy,
): { title: string; description: string } {
  switch (reason) {
    case 'kind_disallowed':
      return copy.registry.kindDisallowed;
    case 'mime_disallowed':
      return copy.registry.mimeDisallowed;
    case 'no_mime_no_ext':
      return copy.registry.unknownType;
    case 'oversize':
      return copy.registry.oversize;
    case 'read_failed':
      // PR-UI-RENDER-3a fixup (@kenji review @msg 5fa6f6a5) — distinct
      // copy for IPC / read failures. v1 collapsed this into
      // `kind_disallowed` which told the user "format unsupported"
      // when the real cause was a missing / unreadable file.
      return copy.registry.readFailed;
    default: {
      const _exhaustive: never = reason;
      return { title: copy.registry.unsupported, description: String(_exhaustive) };
    }
  }
}

/**
 * Renders metadata + reason text. NEVER renders `relativePath` or
 * any absolute path (the input shape doesn't even carry path data).
 */
export function UnsupportedArtifactPreview(props: {
  input: ArtifactPreviewInput;
  reason: Extract<PreviewResolution, { kind: 'unsupported' }>['reason'];
  onShowInFolder?: () => void;
}) {
  const locale = useUiLocale();
  const catalog = getArtifactCopy(locale);
  const copy = describeUnsupportedReason(props.reason, catalog);
  return (
    <Banner
      className="maka-artifact-preview-unsupported"
      data-reason={props.reason}
      status="info"
      role="status"
      title={copy.title}
      description={(
        <>
          <p className="maka-artifact-preview-unsupported-body">{copy.description}</p>
          <dl className="maka-artifact-preview-unsupported-meta">
            <div>
              <dt>{catalog.registry.name}</dt>
              <dd>{props.input.name || catalog.registry.unnamed}</dd>
            </div>
            {props.input.mimeType ? (
              <div>
                <dt>{catalog.registry.type}</dt>
                <dd>{props.input.mimeType}</dd>
              </div>
            ) : null}
            <div>
              <dt>{catalog.registry.size}</dt>
              <dd>{formatPreviewSize(props.input.sizeBytes, locale)}</dd>
            </div>
          </dl>
        </>
      )}
      endContent={props.onShowInFolder ? (
        <Button
          variant="secondary"
          className="maka-artifact-preview-unsupported-cta"
          onClick={props.onShowInFolder}
          label={catalog.registry.openInFinder}
        />
      ) : undefined}
    />
  );
}

/**
 * Loads the image via existing `readBinary` IPC, enforces L2 base64
 * length cap before any decode, and renders inside a bounded
 * container with `object-fit: contain` so an unexpectedly large
 * intrinsic size can't break the chat / pane layout.
 *
 * Critical invariant (@kenji review @msg 5fa6f6a5):
 *   - The post-load L2 decision (`decideImageReadOutcome`) runs
 *     INSIDE the async, BEFORE `setState`. The hook's state union
 *     therefore holds either a `loading` placeholder, an `image`
 *     branch carrying the verified base64, OR an `unsupported`
 *     branch that carries NO base64. A 10MB oversize payload never
 *     enters React state / DevTools snapshot.
 *   - The component below is intentionally a thin switch over the
 *     hook state — it never sees the raw `ArtifactBinaryReadResult`.
 */
function ImageArtifactPreview(props: {
  record: ArtifactDescriptor;
  input: ArtifactPreviewInput;
  onShowInFolder?: () => void;
}) {
  const copy = getArtifactCopy(useUiLocale());
  const result = useImagePreviewLoad(props.record.sessionId, props.record.id);
  if (result.state === 'loading') {
    return (
      <div className="maka-artifact-preview-loading" role="status" aria-live="polite">
        <Spinner
          className="maka-artifact-preview-spinner"
          size="sm"
          aria-hidden="true"
          role="presentation"
        />
        <span>{copy.registry.loadingImage}</span>
      </div>
    );
  }
  if (result.state === 'unsupported') {
    return (
      <UnsupportedArtifactPreview
        input={props.input}
        reason={result.reason}
        onShowInFolder={props.onShowInFolder}
      />
    );
  }
  // result.state === 'image' — exhaustiveness check below.
  return (
    <div className="maka-artifact-preview-image">
      <img
        alt={props.record.name}
        src={`data:${result.safeMime};base64,${result.base64}`}
      />
    </div>
  );
}

function toPreviewInput(record: ArtifactDescriptor): ArtifactPreviewInput {
  return {
    name: record.name,
    kind: record.kind,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
  };
}

/**
 * Hook state for the image preview load. Closed union — the
 * `unsupported` branch DELIBERATELY does NOT carry `base64`.
 *
 * @kenji review @msg 5fa6f6a5: the v1 of this hook held a raw
 * `ArtifactBinaryReadResult` (which carries base64 in its `ok: true`
 * branch). That meant a 10MB oversize payload could land in React
 * state / DevTools before the L2 cap rejected it for rendering. The
 * fix replaces the broad union with this closed three-way one and
 * runs the L2 decision INSIDE the async, so the only `base64` that
 * ever reaches `setState` is one that has already passed
 * `decideImageReadOutcome` (cap + MIME re-validation).
 *
 * Source/test gate (locked by `artifact-preview-registry.test.ts`):
 * the `unsupported` branch type signature MUST NOT include `base64`.
 * Future contributors who try to expand the state to "carry base64
 * alongside the unsupported outcome for debugging" must update both
 * this type AND the kenji-gate test (which fails closed).
 */
type ImagePreviewLoadState =
  | { state: 'loading' }
  | { state: 'image'; safeMime: string; base64: string }
  | {
      state: 'unsupported';
      reason: Extract<PreviewResolution, { kind: 'unsupported' }>['reason'];
    };

function useImagePreviewLoad(
  sessionId: string,
  artifactId: string,
): ImagePreviewLoadState {
  const [state, setState] = useState<ImagePreviewLoadState>({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ state: 'loading' });
    void (async () => {
      try {
        const raw = await window.maka.artifacts.readBinary(sessionId, artifactId);
        if (cancelled) return;
        // L2 decision happens HERE, before `setState`. The pure helper
        // returns `{ kind: 'image', safeMime, base64 }` only when both
        // the base64 length cap AND the MIME re-validation pass; the
        // unsupported branch never carries base64. So `setState` only
        // receives the post-decision shape.
        const outcome = decideImageReadOutcome(raw);
        if (outcome.kind === 'image') {
          setState({ state: 'image', safeMime: outcome.safeMime, base64: outcome.base64 });
        } else {
          setState({ state: 'unsupported', reason: outcome.reason });
        }
      } catch {
        if (cancelled) return;
        // Catch path also never carries base64 — same invariant.
        setState({ state: 'unsupported', reason: 'read_failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactId, sessionId]);
  return state;
}
