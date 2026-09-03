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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast, useUiLocale } from '@maka/ui';
import type { PricingMutation } from '@maka/runtime-host/protocol';
import { useUsagePricingServices } from '../pricing-services-context.js';
import type { UsagePricingServices } from '../pricing-ports.js';
import type { UsageHostRef } from '../ports.js';
import { getPricingSettingsCopy } from '../pricing-copy.js';
import { useActionGuard } from './action-guard.js';
import {
  derivePricingRows,
  validatePricingDraft,
  type PricingDraft,
  type PricingRowView,
} from '../pricing-view-model.js';

// Desktop pricing shapes derive from the `UsagePricingServices` port (whose
// types come from the global `window.maka.settings.pricing` bridge), so the
// feature names them without importing the preload/`shared` Desktop types.
type DesktopPricingSnapshot = Awaited<ReturnType<UsagePricingServices['loadPricing']>>;
type DesktopPricingMutationOutcome = Awaited<ReturnType<UsagePricingServices['mutatePricing']>>;

type PricingEditor =
  | { readonly mode: 'add' }
  | { readonly mode: 'edit'; readonly row: PricingRowView };

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
      readonly latest: DesktopPricingSnapshot;
      readonly reason: 'revision_conflict' | 'outcome_unknown';
    }
  | { readonly kind: 'refresh_failed' }
  | { readonly kind: 'reconcile_unavailable'; readonly reason: 'revision_conflict' | 'outcome_unknown' };

const EMPTY_DRAFT: PricingDraft = {
  provider: '',
  model: '',
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
};

/** Owns the Host-backed Pricing snapshot, the editor draft, and every outcome. */
export function usePricingController(props: {
  readonly describeError: (error: unknown) => string;
  /**
   * The settings-*selected* Runtime Host (threaded as a prop from the legacy
   * surface, not resolved at the bridge). Pricing overrides are per-Host, so the
   * Pricing tab must read/write the same Host as the rest of the settings page —
   * the app's *active* Host (what an omitted bridge arg would resolve) can differ
   * because the settings surface has its own Host selector.
   */
  readonly runtimeHost: UsageHostRef | undefined;
  /**
   * The Usage scope's `targetKey` (`host:epoch`). Pricing services come from a
   * single app-root provider (not a Host-keyed one), so a Host/generation change
   * does not remount this controller; instead this key changes and the reload
   * effect below re-fetches against the fresh Host — mirroring the previous
   * surface's reload-on-generation behaviour.
   */
  readonly generationKey: string;
}) {
  const services = useUsagePricingServices();
  const { describeError } = props;
  const locale = useUiLocale();
  const copy = getPricingSettingsCopy(locale);
  const toast = useToast();

  const [snapshot, setSnapshot] = useState<DesktopPricingSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<PricingEditor | null>(null);
  const [draft, setDraft] = useState<PricingDraft>(EMPTY_DRAFT);
  const [cacheOpen, setCacheOpen] = useState(false);
  const [writeState, setWriteState] = useState<PricingWriteState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [resetTarget, setResetTarget] = useState<PricingRowView | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);

  const guard = useActionGuard<string>();
  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  // Authority sequence: bumped by a reload start (a newer reload supersedes an
  // older one) AND by a committed mutation (`applyOutcome`). A reload captures
  // it and drops its result if it changed while in flight — so a slow refresh
  // started before a save can never land back on top of the saved authority, nor
  // reset a `refresh_failed`/`reconcile` write-block to idle.
  const reloadTicketRef = useRef(0);
  // Bumped whenever the selected Host enters a new lifecycle generation. A
  // mutation captures it at dispatch and drops its result if the generation
  // changed while it was in flight — an old-generation save must never write
  // back onto a freshly loaded snapshot.
  const generationEpochRef = useRef(0);

  useEffect(() => {
    lifecycleRef.current += 1;
    mountedRef.current = true;
    const lifecycle = lifecycleRef.current;
    return () => {
      if (lifecycleRef.current !== lifecycle) return;
      mountedRef.current = false;
      reloadTicketRef.current += 1;
    };
  }, []);

  function isCurrent(lifecycle: number, epoch: number): boolean {
    return (
      mountedRef.current &&
      lifecycleRef.current === lifecycle &&
      generationEpochRef.current === epoch
    );
  }

  async function reload(): Promise<void> {
    const host = props.runtimeHost;
    const lifecycle = lifecycleRef.current;
    const epoch = generationEpochRef.current;
    const ticket = ++reloadTicketRef.current;
    setLoading(true);
    // No selected Host: nothing Host-scoped to load. Resolve to an empty state
    // (like the usage stats loader's no-Host path) rather than letting the bridge
    // fall back to a *different* (active) Host than the settings page shows.
    if (!host) {
      if (isCurrent(lifecycle, epoch) && ticket === reloadTicketRef.current) {
        setSnapshot(null);
        setLoadError(null);
        setWriteState({ kind: 'idle' });
        setLoading(false);
      }
      return;
    }
    try {
      const next = await services.loadPricing(host);
      if (!isCurrent(lifecycle, epoch) || ticket !== reloadTicketRef.current) return;
      setSnapshot(next);
      setLoadError(null);
      setWriteState({ kind: 'idle' });
    } catch (error) {
      if (!isCurrent(lifecycle, epoch) || ticket !== reloadTicketRef.current) return;
      setLoadError(describeError(error));
    } finally {
      if (isCurrent(lifecycle, epoch) && ticket === reloadTicketRef.current) setLoading(false);
    }
  }

  // Load on mount and whenever the selected Host generation changes. Pricing
  // services come from a single app-root provider, so a Host change does not
  // remount this controller; the `generationKey` prop (the Usage scope's
  // `host:epoch`) changes instead, which resets the snapshot and reloads —
  // replacing the previous surface's generation-key remount. A generation bump
  // also fences any in-flight mutation from an older Host (`isCurrent`). The
  // draft is intentionally dropped on a generation change.
  useEffect(() => {
    generationEpochRef.current += 1;
    // A Host generation change is a fresh authority/list. Fence any in-flight
    // reload, drop the snapshot, and reset ALL transient interaction state:
    // close the editor and clear the draft (so an old-Host draft can't be saved
    // onto the new authority), clear the reset target, and release both busy
    // latches + the action guard (so a mutation whose `finally` no longer runs
    // — its epoch changed — can't leave a dialog stuck saving/resetting).
    reloadTicketRef.current += 1;
    setSnapshot(null);
    setWriteState({ kind: 'idle' });
    setEditor(null);
    setDraft(EMPTY_DRAFT);
    setCacheOpen(false);
    setResetTarget(null);
    setSaving(false);
    setResetBusy(false);
    guard.finish();
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.generationKey]);

  const rows = useMemo(() => derivePricingRows(snapshot?.entries ?? []), [snapshot]);
  const existingKeys = useMemo(() => rows.map((row) => row.modelKey), [rows]);
  // Overrides-only surface (#2015 / maintainer direction on #2218): the table
  // shows only the user's custom rows, and adding one picks from the built-in
  // catalog. The Host collapses an overridden built-in into a single `custom`
  // entry, so `catalogRows` is naturally the built-ins NOT yet overridden.
  // `existingKeys` stays over the FULL union for duplicate detection.
  const overrideRows = useMemo(() => rows.filter((row) => row.source === 'custom'), [rows]);
  const catalogRows = useMemo(() => rows.filter((row) => row.source === 'builtin'), [rows]);
  const validation = useMemo(
    () =>
      validatePricingDraft(draft, {
        mode: editor?.mode ?? 'add',
        existingKeys,
        lockedModelKey: editor?.mode === 'edit' ? editor.row.modelKey : undefined,
      }),
    [draft, editor, existingKeys],
  );

  const writesBlocked =
    writeState.kind === 'refresh_failed' || writeState.kind === 'reconcile_unavailable';

  // On a conflict, the fresh-authority row for whatever the user is editing or
  // resetting — so the notice can show the latest value beside their draft
  // rather than only claiming one exists.
  const conflictLatestEntry = useMemo<PricingRowView | null>(() => {
    if (writeState.kind !== 'conflict') return null;
    const key =
      editor?.mode === 'edit'
        ? editor.row.modelKey
        : editor?.mode === 'add'
          ? (validation.config?.modelKey ?? null)
          : (resetTarget?.modelKey ?? null);
    if (!key) return null;
    return derivePricingRows(writeState.latest.entries).find((row) => row.modelKey === key) ?? null;
  }, [writeState, editor, resetTarget, validation]);

  function restoreTriggerFocus() {
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
  }

  function openAdd(trigger: HTMLElement | null) {
    if (writesBlocked) return;
    triggerRef.current = trigger;
    setDraft(EMPTY_DRAFT);
    setCacheOpen(false);
    setEditor({ mode: 'add' });
  }

  function openEdit(row: PricingRowView, trigger: HTMLElement | null) {
    if (writesBlocked) return;
    triggerRef.current = trigger;
    setDraft({
      provider: row.provider,
      model: row.model,
      input: row.inputUsdPer1M,
      output: row.outputUsdPer1M,
      cacheRead: row.cacheReadUsdPer1M ?? null,
      cacheWrite: row.cacheWriteUsdPer1M ?? null,
    });
    setCacheOpen(row.cacheReadUsdPer1M !== undefined || row.cacheWriteUsdPer1M !== undefined);
    setEditor({ mode: 'edit', row });
  }

  /**
   * Pre-fill the open Add draft from a chosen built-in catalog row: the built-in
   * price is the starting point for the override, and the cache section opens iff
   * the built-in carries cache rates. Stays in add mode — the row is a built-in
   * not yet overridden, so its key validates as a new override.
   */
  function pickCatalogModel(row: PricingRowView) {
    setDraft({
      provider: row.provider,
      model: row.model,
      input: row.inputUsdPer1M,
      output: row.outputUsdPer1M,
      cacheRead: row.cacheReadUsdPer1M ?? null,
      cacheWrite: row.cacheWriteUsdPer1M ?? null,
    });
    setCacheOpen(row.cacheReadUsdPer1M !== undefined || row.cacheWriteUsdPer1M !== undefined);
  }

  function closeEditor() {
    if (saving) return;
    setEditor(null);
    if (writeState.kind === 'conflict') setWriteState({ kind: 'idle' });
    restoreTriggerFocus();
  }

  const setField = <K extends keyof PricingDraft>(key: K, value: PricingDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  /** Map a settled outcome to state; `onCommitted` runs on saved/synchronized. */
  function applyOutcome(
    outcome: DesktopPricingMutationOutcome,
    onCommitted: () => void,
    attemptedKey?: string,
  ): void {
    // Fence any reload that was in flight when this mutation committed, so a
    // stale refresh can't overwrite the authority we're about to set (nor reset
    // a write-block to idle). Clear its loading indicator too — the fenced
    // reload's own `finally` will no longer run.
    reloadTicketRef.current += 1;
    setLoading(false);
    switch (outcome.kind) {
      case 'saved':
        setSnapshot(outcome.snapshot);
        setWriteState({ kind: 'idle' });
        onCommitted();
        toast.success(copy.saved, outcome.disposition === 'unchanged' ? copy.synchronized : undefined);
        return;
      case 'synchronized':
        setSnapshot(outcome.snapshot);
        setWriteState({ kind: 'idle' });
        onCommitted();
        toast.success(copy.synchronized);
        return;
      case 'review_required':
        // Adopt fresh authority into the list so it is no longer speculative,
        // keep the draft, and require an explicit second save against `latest`.
        setSnapshot(outcome.snapshot);
        setWriteState({ kind: 'conflict', latest: outcome.snapshot, reason: outcome.reason });
        // If this was an Add and the fresh authority now already has that key
        // (added elsewhere), the duplicate check would leave `validation.config`
        // null and silently block the required second save. Convert the Add into
        // an Edit locked on that key so the explicit re-save upserts against the
        // latest revision (the draft's rates are preserved).
        if (editor?.mode === 'add' && attemptedKey) {
          const latestRow = derivePricingRows(outcome.snapshot.entries).find(
            (row) => row.modelKey === attemptedKey,
          );
          if (latestRow) setEditor({ mode: 'edit', row: latestRow });
        }
        return;
      case 'saved_refresh_failed':
        // The write committed but the post-commit reload failed — the loaded list
        // is now definitely stale. Drop it (#2015: show no speculative final
        // list); the draft is retained and writes stay blocked until a refresh.
        setSnapshot(null);
        setWriteState({ kind: 'refresh_failed' });
        return;
      case 'reconciliation_unavailable':
        setWriteState({ kind: 'reconcile_unavailable', reason: outcome.reason });
        return;
    }
  }

  /** The CAS base: the latest we saw on a conflict, else the loaded snapshot. */
  function mutationBase(): DesktopPricingSnapshot | null {
    return writeState.kind === 'conflict' ? writeState.latest : snapshot;
  }

  async function save() {
    const config = validation.config;
    const base = mutationBase();
    if (!config || !base || saving) return;
    if (!guard.begin('write')) return;
    const lifecycle = lifecycleRef.current;
    const epoch = generationEpochRef.current;
    setSaving(true);
    try {
      const mutation: PricingMutation = { kind: 'upsert', pricing: config };
      const outcome = await services.mutatePricing(props.runtimeHost, base, mutation);
      if (!isCurrent(lifecycle, epoch)) return;
      applyOutcome(
        outcome,
        () => {
          setEditor(null);
          restoreTriggerFocus();
        },
        config.modelKey,
      );
    } catch (error) {
      if (isCurrent(lifecycle, epoch)) {
        toast.error(copy.saveFailed, describeError(error));
      }
    } finally {
      guard.finish();
      if (isCurrent(lifecycle, epoch)) setSaving(false);
    }
  }

  function openReset(row: PricingRowView, trigger: HTMLElement | null) {
    if (writesBlocked) return;
    triggerRef.current = trigger;
    setResetTarget(row);
  }

  function cancelReset() {
    if (resetBusy) return;
    setResetTarget(null);
    restoreTriggerFocus();
  }

  async function confirmReset() {
    const target = resetTarget;
    const base = mutationBase();
    if (!target || !base || resetBusy) return;
    if (!guard.begin('write')) return;
    const lifecycle = lifecycleRef.current;
    const epoch = generationEpochRef.current;
    setResetBusy(true);
    try {
      const mutation: PricingMutation = { kind: 'delete', modelKey: target.modelKey };
      const outcome = await services.mutatePricing(props.runtimeHost, base, mutation);
      if (!isCurrent(lifecycle, epoch)) return;
      applyOutcome(outcome, () => {
        setResetTarget(null);
        restoreTriggerFocus();
        toast.success(copy.resetDone);
      });
      // A conflict keeps the confirm dialog open for an explicit second
      // confirm against fresh authority (mutationBase() now returns `latest`).
      // An uncertain outcome blocks writes — close the dialog; the panel notice
      // explains the next step.
      if (
        outcome.kind === 'saved_refresh_failed' ||
        outcome.kind === 'reconciliation_unavailable'
      ) {
        setResetTarget(null);
      }
    } catch (error) {
      if (isCurrent(lifecycle, epoch)) {
        toast.error(copy.resetFailed, describeError(error));
      }
    } finally {
      guard.finish();
      if (isCurrent(lifecycle, epoch)) setResetBusy(false);
    }
  }

  return {
    copy,
    locale,
    loading,
    loadError,
    rows,
    // Overrides-only table + catalog picker for the Add flow.
    overrideRows,
    catalogRows,
    pickCatalogModel,
    editor,
    draft,
    setField,
    cacheOpen,
    setCacheOpen,
    validation,
    writeState,
    writesBlocked,
    conflictLatestEntry,
    saving,
    resetTarget,
    resetBusy,
    triggerRef,
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
