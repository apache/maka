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

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { useToast, useUiLocale } from '@maka/ui';
import { normalizePricingModelKey } from '@maka/core/usage-stats/pricing';
import {
  createPricingReconciliationTarget,
  pricingReconciliationTargetMatches,
  pricingReconciliationTargetModelKey,
  type EffectivePricingEntry,
  type PricingMutation,
  type PricingReconciliationTarget,
} from '@maka/runtime-host/protocol';
import { useUsagePricingServices } from '../pricing-services-context.js';
import { usePricingEditorDraft } from '../services-context.js';
import type { UsagePricingServices, UsagePricingTarget } from '../pricing-ports.js';
import { getPricingSettingsCopy } from '../../../locales/settings-pricing-copy.js';
import { useActionGuard } from './action-guard.js';
import {
  draftFromPricing,
  validatePricingDraft,
  type PricingDraft,
  type PricingEditorDraft,
} from '../pricing-view-model.js';

// Derive the controller's authority/outcome types from its injected port so the
// port remains the test seam even though it is expressed with shared contracts.
type DesktopPricingSnapshot = Awaited<ReturnType<UsagePricingServices['loadPricing']>>;
type DesktopPricingMutationOutcome = Awaited<ReturnType<UsagePricingServices['mutatePricing']>>;
type PricingOverride = Extract<EffectivePricingEntry, { source: 'custom' }>;

interface PricingWriteAttempt {
  readonly intent: PricingReconciliationTarget;
  /** A cancelled dialog or a different model draft no longer owns this result. */
  readonly dialogGeneration: number;
  /** Immutable input actually submitted, distinct from subsequent user edits. */
  readonly draft: PricingDraft | null;
}

/**
 * Write blockers from #2015: after a save whose post-commit reload failed, or an
 * outcome we could not reconcile, further writes are disabled until a fresh
 * snapshot loads. `conflict` keeps the draft and allows an explicit second save
 * against the latest snapshot.
 */
export type PricingWriteState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'conflict';
      readonly reason: 'revision_conflict' | 'outcome_unknown';
      readonly attempt: PricingWriteAttempt;
    }
  | {
      readonly kind: 'refresh_failed';
      readonly attempt: PricingWriteAttempt;
    }
  | {
      readonly kind: 'reconcile_unavailable';
      readonly reason: 'revision_conflict' | 'outcome_unknown';
      readonly attempt: PricingWriteAttempt;
    };

const EMPTY_DRAFT: PricingDraft = {
  modelKey: '',
  input: '',
  output: '',
  cacheRead: '',
  cacheWrite: '',
};

/** Reclassify against reviewed authority without replacing any rate input. */
function reviewedEditorDraft(
  current: PricingEditorDraft,
  snapshot: DesktopPricingSnapshot,
): PricingEditorDraft {
  const key = normalizePricingModelKey(current.draft.modelKey);
  if (!key.ok) return current;
  const row = snapshot.entries.find(({ pricing }) => pricing.modelKey === key.value);
  if (row?.source === 'custom') {
    return { ...current, mode: 'edit', draft: { ...current.draft, modelKey: key.value } };
  }
  // An Edit whose override disappeared becomes Add; a catalog key that is no
  // longer bundled stays visible as an exact manual key on the new Host.
  return {
    ...current,
    mode: row?.source === 'builtin' && current.mode !== 'manual' ? 'catalog' : 'manual',
  };
}

function validateEditorDraft(editor: PricingEditorDraft | null, existingKeys: readonly string[]) {
  return validatePricingDraft(editor?.draft ?? EMPTY_DRAFT, {
    mode: editor?.mode === 'edit' ? 'edit' : 'add',
    existingKeys,
    lockedModelKey: editor?.mode === 'edit' ? editor.draft.modelKey : undefined,
  });
}

/** Owns disposable pricing authority and outcomes; the Usage scope keeps the draft. */
export function usePricingController(props: {
  readonly describeError: (error: unknown) => string;
  /** Settings-selected Host plus its lifecycle generation (`host:epoch`). */
  readonly target: UsagePricingTarget | null;
}) {
  const services = useUsagePricingServices();
  const { describeError } = props;
  const locale = useUiLocale();
  const copy = getPricingSettingsCopy(locale);
  const toast = useToast();

  const [snapshot, setSnapshot] = useState<DesktopPricingSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setScopeEditor] = usePricingEditorDraft();
  const editorRef = useRef(editor);
  editorRef.current = editor;
  // List refreshes never replace the snapshot the open dialog was based on.
  // Only opening a dialog or explicitly reviewing an outcome adopts authority.
  const [mutationBase, setMutationBase] = useState<DesktopPricingSnapshot | null>(null);
  const draft = editor?.draft ?? EMPTY_DRAFT;
  const cacheOpen = editor?.cacheOpen ?? false;
  const [writeState, setWriteState] = useState<PricingWriteState>({ kind: 'idle' });
  const dialogGenerationRef = useRef(0);
  // A remounted view may recover a draft, but never its former mutation base.
  const [needsReview, setNeedsReview] = useState(editor !== null);
  const [pendingMutation, setPendingMutation] = useState<PricingMutation['kind'] | null>(null);
  const [resetTarget, setResetTarget] = useState<PricingOverride | null>(null);
  const saving = pendingMutation === 'upsert';
  const resetBusy = pendingMutation === 'delete';
  const triggerRef = useRef<HTMLElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusRestorePendingRef = useRef(false);

  const guard = useActionGuard<string>();
  // A single lifecycle generation fences Host replacement and unmount,
  // including StrictMode's effect cleanup/restart.
  const lifecycleRef = useRef(0);
  // Authority sequence: bumped by a reload start (a newer reload supersedes an
  // older one) AND by a committed mutation (`applyOutcome`). A reload captures
  // it and drops its result if it changed while in flight — so a slow refresh
  // started before a save can never land back on top of the saved authority, nor
  // reset a `refresh_failed`/`reconcile` write-block to idle.
  const reloadTicketRef = useRef(0);
  const targetKey = props.target?.generationKey ?? 'no-host';
  const [renderedTargetKey, setRenderedTargetKey] = useState(targetKey);

  // Fence a changed Host during render, before an old asynchronous result can
  // land in the event-to-effect gap. React immediately restarts this component
  // with the new target key. Keep the editor draft, but discard all authority
  // and require review after the replacement snapshot arrives.
  if (targetKey !== renderedTargetKey) {
    setRenderedTargetKey(targetKey);
    lifecycleRef.current += 1;
    reloadTicketRef.current += 1;
    setSnapshot(null);
    setMutationBase(null);
    setLoading(true);
    setLoadError(null);
    setWriteState({ kind: 'idle' });
    setNeedsReview(editor !== null);
    setResetTarget(null);
    setPendingMutation(null);
    guard.finish();
  }

  useEffect(() => () => {
    lifecycleRef.current += 1;
    reloadTicketRef.current += 1;
  }, []);

  function isCurrent(
    lifecycle: number,
    target = props.target,
  ): boolean {
    return (
      lifecycleRef.current === lifecycle &&
      (target === null || target.isCurrent())
    );
  }

  function setEditor(update: SetStateAction<PricingEditorDraft | null>) {
    const next = typeof update === 'function' ? update(editorRef.current) : update;
    if (next?.draft.modelKey.trim() !== editorRef.current?.draft.modelKey.trim()) {
      dialogGenerationRef.current += 1;
      // Retain unresolved writes for reconciliation, but a settled conflict
      // belongs only to the model/dialog that submitted it.
      setWriteState((current) => current.kind === 'conflict' ? { kind: 'idle' } : current);
    }
    // Record input synchronously, even if a pending write settles before React
    // commits the input event. Async completions must see this newer draft.
    editorRef.current = next;
    setScopeEditor(next);
  }

  async function reload(): Promise<void> {
    const host = props.target?.host;
    const pendingWrite =
      writeState.kind === 'refresh_failed' || writeState.kind === 'reconcile_unavailable'
        ? writeState
        : undefined;
    const lifecycle = lifecycleRef.current;
    const ticket = ++reloadTicketRef.current;
    setLoading(true);
    setLoadError(null);
    // No selected Host: nothing Host-scoped to load. Resolve to an empty state
    // (like the usage stats loader's no-Host path) rather than letting the bridge
    // fall back to a *different* (active) Host than the settings page shows.
    if (!host) {
      if (isCurrent(lifecycle) && ticket === reloadTicketRef.current) {
        setSnapshot(null);
        setLoadError(null);
        setWriteState({ kind: 'idle' });
        setLoading(false);
      }
      return;
    }
    try {
      const next = await services.loadPricing(host);
      if (!isCurrent(lifecycle) || ticket !== reloadTicketRef.current) return;
      setLoadError(null);
      if (pendingWrite) {
        applyOutcome(
          {
            kind: pricingReconciliationTargetMatches(pendingWrite.attempt.intent, next.entries)
              ? 'synchronized'
              : 'review_required',
            snapshot: next,
            reason:
              pendingWrite.kind === 'reconcile_unavailable'
                ? pendingWrite.reason
                : 'revision_conflict',
          },
          pendingWrite.attempt,
        );
      } else {
        setSnapshot(next);
      }
    } catch (error) {
      if (!isCurrent(lifecycle) || ticket !== reloadTicketRef.current) return;
      setLoadError(describeError(error));
    } finally {
      if (isCurrent(lifecycle) && ticket === reloadTicketRef.current) setLoading(false);
    }
  }

  // Load on mount and whenever the selected Host generation changes. Settings
  // may also remount this view on a Host identity change or a loading gate.
  // Either path reloads authority and keeps only the scope-owned user draft;
  // lifecycle and target checks reject responses from the discarded view/Host.
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  // Overrides-only surface (#2015 / maintainer direction on #2218): the table
  // shows only the user's custom rows, and adding one picks from the built-in
  // catalog. The Host collapses an overridden built-in into a single `custom`
  // entry, so `catalogRows` is naturally the built-ins NOT yet overridden.
  const overrideRows = useMemo(
    () => snapshot?.entries.filter((row) => row.source === 'custom') ?? [],
    [snapshot],
  );
  const editorSnapshot = mutationBase ?? snapshot;
  const catalogRows = useMemo(
    () => editorSnapshot?.entries.filter((row) => row.source === 'builtin') ?? [],
    [editorSnapshot],
  );
  // Duplicate detection is over the OVERRIDES only (the visible list): picking or
  // typing a built-in that is not yet overridden is a NEW override (an upsert),
  // not a duplicate — only a key that already has a custom row is rejected
  // ("edit its row instead"). Checking the full built-in ∪ overrides union here
  // would wrongly flag every catalog pick (all built-ins) as a duplicate and
  // block its save.
  const overrideKeys = useMemo(() => editorSnapshot?.entries
    .filter((row) => row.source === 'custom')
    .map((row) => row.pricing.modelKey) ?? [], [editorSnapshot]);
  const validation = useMemo(
    () => validateEditorDraft(editor, overrideKeys),
    [editor, overrideKeys],
  );

  const writesBlocked =
    needsReview ||
    writeState.kind === 'refresh_failed' ||
    writeState.kind === 'reconcile_unavailable';

  // Restore focus only after React has committed the dialog/row removal. A
  // timer can run while the row action is still connected, focus that doomed
  // trigger, and then leave focus on <body> when the commit removes it. The
  // layout effect observes the committed DOM and chooses the stable fallback
  // when a successful reset/delete removed the opening row.
  useLayoutEffect(() => {
    if (!focusRestorePendingRef.current) return;
    focusRestorePendingRef.current = false;
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger?.isConnected) trigger.focus();
    else addButtonRef.current?.focus();
  }, [editor, resetTarget]);

  // On a conflict, the fresh-authority row for whatever the user is editing or
  // resetting — so the notice can show the latest value beside their draft
  // rather than only claiming one exists.
  const conflictLatestEntry = useMemo(() => {
    if (writeState.kind !== 'conflict') return null;
    const key = pricingReconciliationTargetModelKey(writeState.attempt.intent);
    return editorSnapshot?.entries.find(({ pricing }) => pricing.modelKey === key) ?? null;
  }, [writeState, editorSnapshot]);

  const hostReviewLatestEntry = needsReview
    ? snapshot?.entries.find(({ pricing }) => pricing.modelKey === draft.modelKey.trim()) ?? null
    : null;

  function restoreTriggerFocus() {
    focusRestorePendingRef.current = true;
  }

  function openAdd(trigger: HTMLElement | null) {
    // No loaded authority (no selected Host, or a load still pending/failed)
    // means a save would have no CAS base and silently no-op — so the editor
    // must not open. The Add control is disabled for the same reason.
    if (writesBlocked || guard.current || snapshot === null) return;
    triggerRef.current = trigger;
    setMutationBase(snapshot);
    setEditor({ mode: 'catalog', draft: EMPTY_DRAFT, cacheOpen: false });
  }

  function openEdit(row: PricingOverride, trigger: HTMLElement | null) {
    if (writesBlocked || guard.current || snapshot === null) return;
    triggerRef.current = trigger;
    setMutationBase(snapshot);
    setEditor({ mode: 'edit', ...draftFromPricing(row.pricing) });
  }

  /**
   * Pre-fill the open Add draft from a chosen built-in catalog row: the built-in
   * price is the starting point for the override, and the cache section opens iff
   * the built-in carries cache rates. Stays in add mode — the row is a built-in
   * not yet overridden, so its key validates as a new override.
   */
  function pickCatalogModel(row: EffectivePricingEntry) {
    setEditor({ mode: 'catalog', ...draftFromPricing(row.pricing) });
  }

  function clearModel(mode: 'catalog' | 'manual' = 'catalog') {
    setEditor({ mode, draft: EMPTY_DRAFT, cacheOpen: false });
  }

  function setCacheOpen(open: boolean) {
    setEditor((current) => current ? { ...current, cacheOpen: open } : null);
  }

  function reviewHostChange() {
    if (!needsReview || loading || snapshot === null || !props.target?.isCurrent()) return;
    setEditor((current) => current ? reviewedEditorDraft(current, snapshot) : null);
    setMutationBase(snapshot);
    setNeedsReview(false);
  }

  function closeEditor() {
    if (guard.current) return;
    setEditor(null);
    setMutationBase(null);
    setNeedsReview(false);
    if (writeState.kind === 'conflict') {
      setWriteState({ kind: 'idle' });
    }
    restoreTriggerFocus();
  }

  const setField = <K extends keyof PricingDraft>(key: K, value: PricingDraft[K]) =>
    setEditor((current) => current && !(current.mode === 'edit' && key === 'modelKey')
      ? { ...current, draft: { ...current.draft, [key]: value } }
      : current);

  function finishReconciledIntent(
    attempt: PricingWriteAttempt,
    latest: DesktopPricingSnapshot,
  ): void {
    if (attempt.intent.kind === 'delete') {
      setResetTarget(null);
      setMutationBase(null);
      restoreTriggerFocus();
      return;
    }
    const current = editorRef.current;
    if (!current) return;
    if (current.draft === attempt.draft) {
      setEditor(null);
      setMutationBase(null);
      restoreTriggerFocus();
      return;
    }
    // The completed write owns only its submitted input. Keep later edits open
    // and promote a saved Add to Edit so its next explicit save stays usable.
    if (current.draft.modelKey.trim() === pricingReconciliationTargetModelKey(attempt.intent)) {
      setEditor(reviewedEditorDraft(current, latest));
      setMutationBase(latest);
      // A different client can write again between our commit and its reload.
      // The new draft must review that change before adopting it as its base.
      if (!pricingReconciliationTargetMatches(attempt.intent, latest.entries)) {
        setWriteState({ kind: 'conflict', reason: 'revision_conflict', attempt });
      }
    }
  }

  function restoreReconciledIntent(
    attempt: PricingWriteAttempt,
    latest: DesktopPricingSnapshot,
  ): void {
    const { intent } = attempt;
    const key = pricingReconciliationTargetModelKey(intent);
    const latestRow = latest.entries.find(({ pricing }) => pricing.modelKey === key);
    if (intent.kind === 'upsert') {
      const current = editorRef.current;
      if (current?.draft.modelKey.trim() === key) {
        setEditor(reviewedEditorDraft(current, latest));
        setMutationBase(latest);
      }
      return;
    }
    setMutationBase(latest);
    if (latestRow?.source === 'custom') setResetTarget(latestRow);
  }

  /** Adopt one settled outcome using the same authority and intent as a reload. */
  function applyOutcome(
    outcome: DesktopPricingMutationOutcome,
    attempt: PricingWriteAttempt,
  ): void {
    // Fence any reload that was in flight when this mutation committed, so a
    // stale refresh can't overwrite the authority we're about to set (nor reset
    // a write-block to idle). Clear its loading indicator too — the fenced
    // reload's own `finally` will no longer run.
    reloadTicketRef.current += 1;
    setLoading(false);
    if ('snapshot' in outcome) {
      setSnapshot(outcome.snapshot);
      setLoadError(null);
    }
    // Reconciliation still updates authority after Cancel. Only its original
    // dialog may be closed, reopened for review, or given a conflict notice.
    const ownsDialog = attempt.dialogGeneration === dialogGenerationRef.current;
    switch (outcome.kind) {
      case 'saved':
        setWriteState({ kind: 'idle' });
        if (ownsDialog) finishReconciledIntent(attempt, outcome.snapshot);
        toast.success(copy.saved, outcome.disposition === 'unchanged' ? copy.synchronized : undefined);
        return;
      case 'synchronized':
        setWriteState({ kind: 'idle' });
        if (ownsDialog) finishReconciledIntent(attempt, outcome.snapshot);
        toast.success(copy.synchronized);
        return;
      case 'review_required':
        if (!ownsDialog) {
          setWriteState({ kind: 'idle' });
          return;
        }
        // Adopt fresh authority into the list so it is no longer speculative,
        // keep the draft, and require an explicit second save against `latest`.
        setWriteState({ kind: 'conflict', reason: outcome.reason, attempt });
        // If this was an Add and the fresh authority now already has that key
        // (added elsewhere), the duplicate check would leave `validation.config`
        // null and silently block the required second save. Convert the Add into
        // an Edit locked on that key so the explicit re-save upserts against the
        // latest revision (the draft's rates are preserved).
        restoreReconciledIntent(attempt, outcome.snapshot);
        return;
      case 'saved_refresh_failed':
        // The write committed but the post-commit reload failed — the loaded list
        // is now definitely stale. Drop it (#2015: show no speculative final
        // list); retain both the draft and intended end state so an in-dialog
        // refresh can confirm the committed write without replaying it.
        setSnapshot(null);
        setWriteState({ kind: 'refresh_failed', attempt });
        return;
      case 'reconciliation_unavailable':
        setWriteState({ kind: 'reconcile_unavailable', reason: outcome.reason, attempt });
        return;
    }
  }

  /** Every submit path shares the write blockers, CAS base, and lifecycle fence. */
  async function mutate(mutation: PricingMutation): Promise<void> {
    const base = mutationBase;
    const target = props.target;
    if (writesBlocked || !base || !target?.isCurrent()) return;
    if (!guard.begin('write')) return;
    const lifecycle = lifecycleRef.current;
    const attempt: PricingWriteAttempt = {
      intent: createPricingReconciliationTarget(base.entries, mutation),
      dialogGeneration: dialogGenerationRef.current,
      draft: mutation.kind === 'upsert' ? editorRef.current?.draft ?? null : null,
    };
    setPendingMutation(mutation.kind);
    try {
      const outcome = await services.mutatePricing(target.host, base, mutation);
      if (!isCurrent(lifecycle, target)) return;
      applyOutcome(outcome, attempt);
    } catch (error) {
      if (isCurrent(lifecycle, target)) {
        toast.error(mutation.kind === 'upsert' ? copy.saveFailed : copy.resetFailed, describeError(error));
      }
    } finally {
      if (isCurrent(lifecycle, target)) {
        guard.finish();
        setPendingMutation(null);
      }
    }
  }

  async function save(): Promise<void> {
    const current = editorRef.current;
    if (!current) return;
    const { config } = validateEditorDraft(current, overrideKeys);
    if (config) await mutate({ kind: 'upsert', pricing: config });
  }

  function openReset(
    row: PricingOverride,
    trigger: HTMLElement | null,
  ) {
    if (writesBlocked || guard.current || snapshot === null) return;
    dialogGenerationRef.current += 1;
    triggerRef.current = trigger;
    setMutationBase(snapshot);
    setResetTarget(row);
  }

  function cancelReset() {
    if (guard.current) return;
    dialogGenerationRef.current += 1;
    setResetTarget(null);
    setMutationBase(null);
    if (writeState.kind === 'conflict') setWriteState({ kind: 'idle' });
    restoreTriggerFocus();
  }

  async function confirmReset(): Promise<void> {
    if (resetTarget) await mutate({ kind: 'delete', modelKey: resetTarget.pricing.modelKey });
  }

  return {
    copy,
    addButtonRef,
    loading,
    loadError,
    // A write needs a loaded snapshot as its CAS base; without one (no Host, or
    // a load pending/failed) the Add flow is disabled rather than silently
    // no-opping on save.
    hasAuthority: snapshot !== null,
    // Overrides-only table + catalog picker for the Add flow.
    overrideRows,
    catalogRows,
    pickCatalogModel,
    clearModel,
    editor,
    draft,
    setField,
    cacheOpen,
    setCacheOpen,
    validation,
    writeState,
    needsReview,
    writesBlocked,
    reviewHostChange,
    conflictLatestEntry,
    hostReviewLatestEntry,
    saving,
    resetTarget,
    resetBusy,
    reload,
    openAdd,
    openEdit,
    closeEditor,
    save,
    openReset,
    cancelReset,
    confirmReset,
  };
}
