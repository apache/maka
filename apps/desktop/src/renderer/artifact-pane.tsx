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
 * Right-side ArtifactPane for the chat shell.
 *
 * Responsibilities — and the five review gates that drive them:
 *
 *  1. **Path-safety boundary**: this component never assembles absolute
 *     paths. It only calls `window.maka.artifacts.{list,readText,readBinary,
 *     delete,subscribeChanges}` and `window.maka.app.openArtifactPath`. The
 *     renderer doesn't even *see* `{workspaceRoot}/artifacts/…` — main
 *     does the realpath prefix check before exposing anything.
 *
 *  2. **HTML sandbox** (delegated to ArtifactPreview): `sandbox="allow-scripts"`
 *     ONLY. The "外部链接已禁用" status bar lives in the preview.
 *
 *  3. **Failure-state coverage** (delegated to ArtifactPreview): all five
 *     `ArtifactReadFailureReason`s have explicit Chinese copy.
 *
 *  4. **Workbar ownership**: the component owns artifact data and content,
 *     while SessionWorkbar owns visibility, width, tabs, and collapse state.
 *
 *  5. **Copy/export policy**: only the text-based kinds (`file`, `diff`,
 *     `html`) expose a Copy button. `image` / `pdf` rows do NOT — those are
 *     binary, and silently base64-stuffing a multi-MB PDF into the clipboard
 *     is a footgun. Both kinds still get「在 Finder 中打开」and「另存为」.
 *
 * Layout: fills the Generated files tab and switches between a list and one
 * full-panel preview while reporting its authoritative filtered count.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ICON_SIZE,
  AlertTriangle,
  ArrowLeft,
  FileCode,
  FileImage,
  FileText,
  FileType,
  GitMerge,
  RefreshCcw,
  Save,
  FolderOpen,
  Copy,
  Trash2,
} from '@maka/ui/icons';
import type { ArtifactDescriptor, ArtifactKind } from '@maka/core/artifacts';
import type { UiLocale } from '@maka/core/ui-locale';
import { formatRelativeTimestamp } from '@maka/core/relative-time';
import { generalizedErrorMessage, generalizedErrorMessageChinese, redactSecrets } from '@maka/core/redaction';
import {
  Badge,
  Banner,
  Button,
  MoreMenu,
  formatBytes,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { EmptyState as AstryxEmptyState } from '@astryxdesign/core';
import { ArtifactPreview } from './artifact-preview';
import { nextArtifactListAction } from './artifact-list-keyboard';
import { filterUserVisibleArtifacts } from './artifact-visibility';
import { openPathFailureCopy } from './open-path';
import { getArtifactCopy, type ArtifactCopy } from './locales/artifact-copy';

export function ArtifactPane(props: {
  sessionId: string;
  onCountChange?: (count: number) => void;
  onDismiss?: () => void;
}) {
  const { sessionId } = props;
  const toast = useToast();
  const locale = useUiLocale();
  const copy = getArtifactCopy(locale);
  const emptyStateCopy = {
    title: copy.pane.empty,
    description: copy.pane.emptyHint,
  };
  const [records, setRecords] = useState<ArtifactDescriptor[]>([]);
  const [recordsSessionId, setRecordsSessionId] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<
    { kind: 'list' } | { kind: 'preview'; artifactId: string }
  >({ kind: 'list' });
  const [listError, setListError] = useState<{
    sessionId: string;
    message: string;
  } | null>(null);
  const [pendingArtifactListRetry, setPendingArtifactListRetry] = useState(false);
  const [artifactActionBusy, setArtifactActionBusy] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const artifactListRequestSeqRef = useRef(0);
  const artifactPaneMountedRef = useMountedRef();
  const artifactPaneSessionIdRef = useRef<string | undefined>(sessionId);
  const recordsSessionIdRef = useRef<string | undefined>(undefined);
  const pendingArtifactListRetryRef = useRef(false);
  const pendingArtifactActionRef = useRef<string | null>(null);

  artifactPaneSessionIdRef.current = sessionId;

  // ---- live data ---------------------------------------------------------

  useEffect(() => {
    return () => {
      artifactListRequestSeqRef.current += 1;
      pendingArtifactListRetryRef.current = false;
      pendingArtifactActionRef.current = null;
    };
  }, []);

  useEffect(() => {
    setView({ kind: 'list' });
    setSelectedId(null);
  }, [sessionId]);

  const refresh = useCallback(async () => {
    const requestSeq = ++artifactListRequestSeqRef.current;
    if (!sessionId) {
      recordsSessionIdRef.current = undefined;
      setRecordsSessionId(undefined);
      setRecords([]);
      setListError(null);
      return;
    }
    try {
      const next = await window.maka.artifacts.list(sessionId, {
        includeDeleted: true,
      });
      if (artifactPaneMountedRef.current && requestSeq === artifactListRequestSeqRef.current) {
        recordsSessionIdRef.current = sessionId;
        setRecordsSessionId(sessionId);
        setRecords(next);
        setListError(null);
      }
    } catch (error) {
      if (artifactPaneMountedRef.current && requestSeq === artifactListRequestSeqRef.current) {
        const message = artifactActionErrorMessage(error, locale, copy);
        setListError({ sessionId, message });
        if (recordsSessionIdRef.current !== sessionId) {
          recordsSessionIdRef.current = undefined;
          setRecordsSessionId(undefined);
          setRecords([]);
        } else {
          toast.error(copy.pane.refreshFailed, message, undefined, { sessionId });
        }
      }
    }
  }, [copy, locale, sessionId, toast]);

  useEffect(() => {
    void refresh();
    if (!sessionId) return;
    // Keep the list in sync without polling. The
    // backend emits `{ reason: 'created' | 'deleted' | 'purged' }` on the
    // `artifacts:changed` channel; we just re-list since the list is bounded
    // (one session's worth) and the metadata is already in memory on main.
    const unsubscribe = window.maka.artifacts.subscribeChanges((event) => {
      if (event.sessionId === sessionId) {
        void refresh();
      }
    });
    return () => {
      artifactListRequestSeqRef.current += 1;
      unsubscribe();
    };
  }, [sessionId, refresh]);

  const activeRecords = useMemo(
    () => (recordsSessionId === sessionId ? filterUserVisibleArtifacts(records) : []),
    [records, recordsSessionId, sessionId],
  );

  useEffect(() => {
    props.onCountChange?.(activeRecords.length);
  }, [activeRecords.length, props.onCountChange]);

  // 已删除墓碑记录保持可选，用于展示明确失败态；只有选中 id 彻底消失时才回退到最新 live artifact。
  useEffect(() => {
    if (activeRecords.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !activeRecords.some((record) => record.id === selectedId)) {
      setSelectedId(preferredArtifactSelectionId(activeRecords));
    }
  }, [activeRecords, selectedId]);

  const previewRecord = useMemo(
    () => view.kind === 'preview'
      ? activeRecords.find((record) => record.id === view.artifactId) ?? null
      : null,
    [activeRecords, view],
  );
  const listRef = useRef<HTMLUListElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const activeListError = listError && listError.sessionId === sessionId ? listError.message : null;

  useEffect(() => {
    if (view.kind === 'preview' && recordsSessionId === sessionId && !previewRecord) {
      setView({ kind: 'list' });
      requestAnimationFrame(() => listRef.current?.focus());
    }
  }, [previewRecord, recordsSessionId, sessionId, view]);

  // ---- actions -----------------------------------------------------------

  // One action at a time across the More menu and the unsupported-preview CTA.
  // The ref is the concurrency guard; state only disables the visible menu.
  async function runArtifactAction(actionKey: string, action: () => Promise<void>) {
    if (pendingArtifactActionRef.current !== null) return;
    pendingArtifactActionRef.current = actionKey;
    setArtifactActionBusy(true);
    try {
      await action();
    } finally {
      if (pendingArtifactActionRef.current === actionKey) {
        pendingArtifactActionRef.current = null;
      }
      if (artifactPaneMountedRef.current) setArtifactActionBusy(false);
    }
  }

  function isArtifactActionSurfaceActive(actionSessionId: string | undefined): boolean {
    return Boolean(
      actionSessionId &&
        artifactPaneMountedRef.current &&
        artifactPaneSessionIdRef.current === actionSessionId &&
        recordsSessionIdRef.current === actionSessionId,
    );
  }

  async function retryArtifactListRefresh() {
    if (pendingArtifactListRetryRef.current) return;
    pendingArtifactListRetryRef.current = true;
    setPendingArtifactListRetry(true);
    try {
      await refresh();
    } finally {
      pendingArtifactListRetryRef.current = false;
      if (artifactPaneMountedRef.current) setPendingArtifactListRetry(false);
    }
  }

  async function openInFinder(artifactId: string) {
    const actionSessionId = sessionId;
    try {
      const result = await window.maka.app.openArtifactPath(sessionId, artifactId);
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      if (!result.ok) {
        toast.error(
          copy.pane.openFailed,
          openPathFailureCopy(result.reason, locale),
          undefined,
          { sessionId: actionSessionId },
        );
      }
    } catch (error) {
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.error(
        copy.pane.openFailed,
        artifactActionErrorMessage(error, locale, copy),
        undefined,
        { sessionId: actionSessionId },
      );
    }
  }

  async function copyText(artifactId: string) {
    // Only text-backed kinds reach this code path; binary kinds don't render
    // a copy button (review gate #5). We still defensively guard so a stray
    // call doesn't leak base64 into the clipboard.
    const record = activeRecords.find((entry) => entry.id === artifactId);
    if (!record || !isTextKind(record.kind)) return;
    const actionSessionId = sessionId;
    let result: Awaited<ReturnType<typeof window.maka.artifacts.readText>>;
    try {
      result = await window.maka.artifacts.readText(sessionId, artifactId);
    } catch (error) {
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.error(
        copy.pane.copyFailed,
        artifactActionErrorMessage(error, locale, copy),
        undefined,
        { sessionId: actionSessionId },
      );
      return;
    }
    if (!isArtifactActionSurfaceActive(actionSessionId)) return;
    if (!result.ok) {
      toast.error(
        copy.pane.copyFailed,
        copy.pane.readTextFailed,
        undefined,
        { sessionId: actionSessionId },
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(result.text);
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.success(copy.pane.copied, `${record.name} · ${formatBytes(record.sizeBytes)}`);
    } catch (error) {
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.error(copy.pane.copyFailed, artifactActionErrorMessage(error, locale, copy));
    }
  }

  async function saveAs(artifactId: string) {
    const actionSessionId = sessionId;
    try {
      const result = await window.maka.app.saveArtifactAs(sessionId, artifactId);
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      if (result.ok) {
        const record = activeRecords.find((entry) => entry.id === artifactId);
        toast.success(copy.pane.saved, record?.name ?? result.saved);
        return;
      }
      if (result.reason === 'canceled') return;
      toast.error(
        copy.pane.saveFailed,
        saveArtifactFailureCopy(result.reason, copy),
        undefined,
        { sessionId: actionSessionId },
      );
    } catch (error) {
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.error(
        copy.pane.saveFailed,
        artifactActionErrorMessage(error, locale, copy),
        undefined,
        { sessionId: actionSessionId },
      );
    }
  }

  async function deleteArtifact(artifactId: string) {
    const actionSessionId = sessionId;
    const record = activeRecords.find((entry) => entry.id === artifactId);
    const name = record?.name ?? copy.pane.fallbackName;
    const ok = await toast.confirm({
      title: copy.pane.deleteTitle(name),
      description: copy.pane.deleteDescription,
      confirmLabel: copy.pane.delete,
      cancelLabel: copy.pane.cancel,
      destructive: true,
    });
    if (!ok) return;
    if (!isArtifactActionSurfaceActive(actionSessionId)) return;
    try {
      await window.maka.artifacts.delete(sessionId, artifactId);
      await refresh();
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.success(copy.pane.deleted(name));
    } catch (error) {
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.error(
        copy.pane.deleteFailed(name),
        artifactActionErrorMessage(error, locale, copy),
        undefined,
        { sessionId: actionSessionId },
      );
    }
  }

  // ---- render ------------------------------------------------------------

  // The list is one tab stop. Arrow keys move the roving selection; Enter or
  // Space opens the selected file in the panel's second, full-height state.
  function focusComposer() {
    // Defer to the next frame so the Esc handler doesn't unfocus + refocus
    // in the same tick.
    requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLElement>('.maka-composer [contenteditable="true"]');
      composer?.focus();
    });
  }

  function dismissPaneToComposer() {
    props.onDismiss?.();
    focusComposer();
  }

  function openPreview(artifactId: string) {
    setSelectedId(artifactId);
    setView({ kind: 'preview', artifactId });
    requestAnimationFrame(() => previewRef.current?.focus());
  }

  function returnToList() {
    setMoreMenuOpen(false);
    setView({ kind: 'list' });
    requestAnimationFrame(() => listRef.current?.focus());
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const action = nextArtifactListAction({
      currentSelectedId: selectedId ?? undefined,
      visibleIds: activeRecords.map((record) => record.id),
      key: event.key,
    });
    if (action.kind === 'noop') return;
    event.preventDefault();
    event.stopPropagation();
    switch (action.kind) {
      case 'select':
        setSelectedId(action.targetId);
        break;
      case 'activate':
        openPreview(action.targetId);
        break;
      case 'dismiss':
        dismissPaneToComposer();
        break;
    }
  }

  function handlePaneKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    if (moreMenuOpen) return;
    const target = event.target;
    if (!(target instanceof Node) || !event.currentTarget.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (view.kind === 'preview') {
      returnToList();
    } else {
      dismissPaneToComposer();
    }
  }

  return (
    <div className="maka-artifact-pane" role="region" aria-label={copy.pane.panelAria} onKeyDown={handlePaneKeyDown}>
      {activeListError && (
        <Banner
          status="error"
          className="maka-artifact-list-error"
          icon={<AlertTriangle size={ICON_SIZE.control} aria-hidden="true" />}
          title={copy.pane.listLoadFailed}
          description={activeListError}
          endContent={(
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void retryArtifactListRefresh()}
              isLoading={pendingArtifactListRetry}
              icon={<RefreshCcw size={ICON_SIZE.meta} aria-hidden="true" />}
              label={copy.pane.retry}
            />
          )}
        />
      )}
      {view.kind === 'list' ? (
        activeRecords.length > 0 ? (
          <ul
            ref={listRef}
            className="maka-artifact-list"
            role="listbox"
            aria-label={copy.pane.listAria}
            aria-activedescendant={selectedId ? `maka-artifact-row-${selectedId}` : undefined}
            tabIndex={0}
            onKeyDown={handleListKeyDown}
          >
            {activeRecords.map((record) => (
              <li key={record.id} className="maka-artifact-list-item">
                <Button
                  id={`maka-artifact-row-${record.id}`}
                  variant="ghost"
                  className="maka-artifact-row"
                  role="option"
                  aria-selected={record.id === selectedId}
                  // @kenji a11y gate #1: single tab stop in the list. Each
                  // row gets tabIndex=-1 so the user reaches the list via
                  // the list's own tabIndex, then drives selection with
                  // ArrowUp/Down.
                  tabIndex={-1}
                  data-selected={record.id === selectedId ? 'true' : 'false'}
                  data-deleted={record.status === 'deleted' ? 'true' : 'false'}
                  onClick={() => openPreview(record.id)}
                  label={record.name}
                  icon={(
                    <span className="maka-artifact-row-icon" aria-hidden="true">
                      <KindIcon kind={record.kind} />
                    </span>
                  )}
                  endContent={(
                    <span className="maka-artifact-row-meta">
                      <span className="maka-artifact-row-size">{formatBytes(record.sizeBytes)}</span>
                      <span className="maka-artifact-row-time">
                        {formatRelativeTimestamp(record.createdAt, Date.now(), locale)}
                      </span>
                      {record.status === 'deleted' && (
                        <Badge variant="error" className="maka-artifact-row-badge" label={copy.pane.deletedBadge} />
                      )}
                    </span>
                  )}
                />
              </li>
            ))}
          </ul>
        ) : (
          <AstryxEmptyState
            className="maka-artifact-list-empty"
            icon={<FileText size={ICON_SIZE.empty} aria-hidden="true" />}
            {...emptyStateCopy}
          />
        )
      ) : previewRecord ? (
        <div className="maka-artifact-preview-screen">
          <header className="maka-artifact-preview-header">
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<ArrowLeft size={ICON_SIZE.chrome} aria-hidden="true" />}
              label={copy.pane.back}
              onClick={returnToList}
            />
            <div className="maka-artifact-preview-heading">
              <strong title={previewRecord.name}>{previewRecord.name}</strong>
              <span>
                {formatBytes(previewRecord.sizeBytes)} · {formatRelativeTimestamp(previewRecord.createdAt, Date.now(), locale)}
              </span>
            </div>
            <MoreMenu
              className="maka-artifact-preview-more"
              size="sm"
              label={copy.pane.moreActions(previewRecord.name)}
              isDisabled={artifactActionBusy}
              isMenuOpen={moreMenuOpen}
              onOpenChange={setMoreMenuOpen}
              items={[
                {
                  label: copy.pane.openInFinder,
                  icon: <FolderOpen size={ICON_SIZE.control} aria-hidden="true" />,
                  onClick: () => void runArtifactAction(`${previewRecord.id}:open`, () => openInFinder(previewRecord.id)),
                },
                {
                  label: copy.pane.saveAs,
                  icon: <Save size={ICON_SIZE.control} aria-hidden="true" />,
                  onClick: () => void runArtifactAction(`${previewRecord.id}:save`, () => saveAs(previewRecord.id)),
                },
                ...(isTextKind(previewRecord.kind)
                  ? [{
                      label: copy.pane.copy,
                      icon: <Copy size={ICON_SIZE.control} aria-hidden="true" />,
                      onClick: () => void runArtifactAction(`${previewRecord.id}:copy`, () => copyText(previewRecord.id)),
                    }]
                  : []),
                { type: 'divider' as const },
                {
                  label:
                    previewRecord.source === 'deep_research' ||
                    previewRecord.source === 'tool_result_archive'
                      ? copy.pane.deleteReadOnly
                      : copy.pane.delete,
                  icon: <Trash2 size={ICON_SIZE.control} aria-hidden="true" />,
                  isDisabled:
                    previewRecord.source === 'deep_research' ||
                    previewRecord.source === 'tool_result_archive',
                  onClick: () => void runArtifactAction(
                    `${previewRecord.id}:delete`,
                    () => deleteArtifact(previewRecord.id),
                  ),
                },
              ]}
            />
          </header>
          <div
            ref={previewRef}
            className="maka-artifact-preview"
            role="region"
            aria-label={copy.pane.previewNamed(previewRecord.name)}
            tabIndex={-1}
          >
            <ArtifactPreview
              key={previewRecord.id}
              record={previewRecord}
              onShowInFolder={() => void runArtifactAction(
                `${previewRecord.id}:open`,
                () => openInFinder(previewRecord.id),
              )}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------

function isTextKind(kind: ArtifactKind): boolean {
  return kind === 'file' || kind === 'diff' || kind === 'html';
}

function saveArtifactFailureCopy(reason: string, copy: ArtifactCopy): string {
  switch (reason) {
    case 'not_found':
      return copy.pane.saveFailures.not_found;
    case 'not_allowed':
      return copy.pane.saveFailures.not_allowed;
    case 'deleted':
      return copy.pane.saveFailures.deleted;
    case 'write_failed':
      return copy.pane.saveFailures.write_failed;
    default:
      return copy.pane.saveFailures.default;
  }
}

function artifactActionErrorMessage(error: unknown, locale: UiLocale, copy: ArtifactCopy): string {
  const raw = redactSecrets(error instanceof Error ? error.message : String(error ?? '')).trim();
  if (!raw) return copy.pane.actionFailed;
  const classified = locale === 'zh'
    ? generalizedErrorMessageChinese(new Error(raw), '')
    : generalizedErrorMessage(new Error(raw), '');
  if (classified) return classified;
  return locale === 'zh' && /[\u4e00-\u9fff]/.test(raw) ? raw : copy.pane.actionFailed;
}

function KindIcon(props: { kind: ArtifactKind }) {
  switch (props.kind) {
    case 'file':
      return <FileText size={ICON_SIZE.control} />;
    case 'diff':
      return <GitMerge size={ICON_SIZE.control} />;
    case 'html':
      return <FileCode size={ICON_SIZE.control} />;
    case 'image':
      return <FileImage size={ICON_SIZE.control} />;
    case 'pdf':
      return <FileType size={ICON_SIZE.control} />;
  }
}

/* PR-FORMAT-BYTES-DEDUP-0 (round 21/30): the local `formatBytes`
   was a less-robust variant of the one in `@maka/ui`
   components.tsx. Removed; we now import the shared helper. */

/* PR-FORMAT-RELATIVE-DEDUP-0 (round 22/30): the local
   `formatRelative` was a less-feature variant of @maka/core's
   `formatRelativeTimestamp` — it missed clock-skew handling,
   the 7-day-then-absolute horizon, and the locale-switching
   formatter cache. Removed; we import the shared helper. */

function preferredArtifactSelectionId(records: readonly ArtifactDescriptor[]): string | null {
  return (records.find((record) => record.status !== 'deleted') ?? records[0])?.id ?? null;
}
