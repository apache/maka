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
 * Full-panel preview for a workspace file referenced from transcript Markdown
 * (`#2664`). Mounted inside the ArtifactPane's `files` tab so the preview goes
 * through the SAME viewer surface (`TextFilePreview`) — no second document
 * viewer.
 *
 * Trust/failure posture:
 *   - The raw reference is forwarded untouched; desktop main owns resolution,
 *     sandbox containment, and reading. This component never assembles paths.
 *   - Every failure renders a non-destructive inline notice; nothing navigates
 *     away and no session state changes (the conversation stays mounted with
 *     its scroll position).
 *   - "Open locally" / "Reveal in folder" are explicit user actions routed to
 *     main-process shell wrappers via IPC.
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, FolderOpen, ICON_SIZE } from '@maka/ui/icons';
import { Banner, Button, useToast, useUiLocale } from '@maka/ui';
import { Spinner } from '@astryxdesign/core/Spinner';
import type { WorkspaceFileTextReadResult } from '../../ports.js';
import { TextFilePreview } from './artifact-preview.js';
import type { WorkspaceFilePreviewRequest } from './workspace-file-preview-request.js';
import { getArtifactCopy, type ArtifactCopy } from '../../../../locales/artifact-copy.js';
import { useWorkbarServices } from '../../services-context.js';

export function WorkspaceFilePreview(props: {
  request: WorkspaceFilePreviewRequest;
  onBack: () => void;
}) {
  const { request } = props;
  const { workspaceFiles } = useWorkbarServices();
  const toast = useToast();
  const copy = getArtifactCopy(useUiLocale());
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; result: WorkspaceFileTextReadResult }
  >({ kind: 'loading' });
  const busyRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    setState({ kind: 'loading' });
    workspaceFiles
      .readText(request.sessionId, request.reference)
      .then((result) => {
        if (!disposed) setState({ kind: 'ready', result });
      })
      .catch(() => {
        // Transport failures stay non-destructive and inline.
        if (!disposed) setState({ kind: 'ready', result: { ok: false, reason: 'read_failed' } });
      });
    return () => {
      disposed = true;
    };
  }, [request, workspaceFiles]);

  async function runAction(action: () => Promise<{ ok: boolean }>) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const result = await action();
      if (!result.ok) {
        toast.error(copy.workspace.openFailed, copy.workspace.failures['open-failed'].description);
      }
    } catch {
      toast.error(copy.workspace.openFailed, copy.workspace.failures['open-failed'].description);
    } finally {
      busyRef.current = false;
    }
  }

  const failure = state.kind === 'ready' && !state.result.ok ? state.result.reason : null;

  return (
    <div className="maka-artifact-preview-screen">
      <header className="maka-artifact-preview-header">
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<ArrowLeft size={ICON_SIZE.chrome} aria-hidden="true" />}
          label={copy.workspace.back}
          onClick={props.onBack}
        />
        <div className="maka-artifact-preview-heading">
          <strong title={request.reference}>{request.reference}</strong>
        </div>
        <div className="maka-artifact-preview-more" style={{ display: 'flex', gap: 4 }}>
          <Button
            variant="ghost"
            size="sm"
            icon={<FolderOpen size={ICON_SIZE.control} aria-hidden="true" />}
            label={copy.workspace.revealInFolder}
            isDisabled={failure === 'outside_workspace' || failure === 'invalid_reference'}
            onClick={() => void runAction(() =>
              workspaceFiles.revealInFolder(request.sessionId, request.reference),
            )}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={<ExternalLink size={ICON_SIZE.control} aria-hidden="true" />}
            label={copy.workspace.openLocally}
            isDisabled={failure === 'outside_workspace' || failure === 'invalid_reference'}
            onClick={() => void runAction(() =>
              workspaceFiles.openLocally(request.sessionId, request.reference),
            )}
          />
        </div>
      </header>
      <div
        className="maka-artifact-preview"
        role="region"
        aria-label={copy.workspace.panelAria(request.reference)}
      >
        {state.kind === 'loading' ? (
          <div className="maka-artifact-preview-loading" role="status" aria-live="polite">
            <Spinner size="sm" aria-hidden="true" role="presentation" />
            <span>{copy.workspace.loading}</span>
          </div>
        ) : state.result.ok ? (
          <TextFilePreview name={state.result.name} text={state.result.text} copy={copy} />
        ) : (
          <FailureNotice reason={state.result.reason} copy={copy} />
        )}
      </div>
    </div>
  );
}

function FailureNotice(props: {
  reason: Extract<WorkspaceFileTextReadResult, { ok: false }>['reason'];
  copy: ArtifactCopy;
}) {
  const entry = props.copy.workspace.failures[props.reason];
  const tone = props.reason === 'too_large'
    || props.reason === 'unsupported_type'
    || props.reason === 'workspace_unavailable'
    || props.reason === 'invalid_reference'
    ? 'info'
    : 'destructive';
  return (
    <Banner
      className="maka-artifact-preview-fail"
      data-tone={tone}
      status={tone === 'destructive' ? 'error' : 'info'}
      role="status"
      title={entry.title}
      description={entry.description}
    />
  );
}
