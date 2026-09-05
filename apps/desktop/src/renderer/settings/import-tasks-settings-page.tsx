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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { List, ListItem } from '@astryxdesign/core/List';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextInput } from '@astryxdesign/core/TextInput';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { normalizeExternalSessionQueryText } from '@maka/core/external-session';
import { uiLocaleToIntlLocale } from '@maka/core/ui-locale';
import type {
  DesktopRuntimeHostRef,
  DesktopSessionSummary,
} from '../../preload/bridge-contract.js';
import {
  EMPTY_LISTED_SELECTION,
  listedSelectionMasterState,
  pruneListedSelection,
  setAllListedSelected,
  Spinner,
  toggleListedSelection,
  useMountedRef,
  useUiLocale,
} from '@maka/ui';
import { ICON_SIZE, MessageSquare } from '@maka/ui/icons';
import { getExternalSessionImportCopy } from '../locales/external-session-import-copy.js';
import { localizedShellErrorMessage } from '../locales/shell-copy.js';
import type { DesktopExternalSessionCatalogItem } from '../../preload/external-session-catalog.js';
import { SettingsPage, SettingsSection } from './settings-section.js';
import { useRuntimeHostSettingsTarget } from './runtime-host-settings-target.js';

type CatalogState = {
  sessions: DesktopExternalSessionCatalogItem[];
  nextCursor: string | null;
};

const EMPTY_CATALOG: CatalogState = { sessions: [], nextCursor: null };
const EXTERNAL_SESSION_IMPORT_POLL_MS = 1_000;

/**
 * A loaded catalog is cached per (source, archived filter, search) so switching
 * back to a source or filter already viewed shows its rows instantly instead of
 * blanking to the "reading external conversations" spinner on every switch. The
 * key is the same tuple `catalogSelectionRef` tracks, so a cache hit and a
 * selection match always agree on what "this catalog" is.
 */
function catalogSelectionKey(adapterId: string, includeArchived: boolean, search: string): string {
  return `${adapterId} ${includeArchived ? '1' : '0'} ${search}`;
}

// A few dozen selections is plenty to make back-and-forth switching instant
// without letting a long search session grow the cache without bound. Re-insert
// on write so the oldest untouched selection is the one evicted.
const CATALOG_CACHE_LIMIT = 24;

function writeCatalogCache(
  cache: Map<string, CatalogState>,
  key: string,
  value: CatalogState,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CATALOG_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

type CatalogWindow = CatalogState & {
  targetSource: DesktopExternalSessionCatalogItem | undefined;
};

async function readCatalogWindow(input: {
  adapterId: string;
  includeArchived: boolean;
  text: string;
  minimumItemCount: number;
  targetSourceSessionId?: string;
  host?: DesktopRuntimeHostRef;
  isCurrent(): boolean;
}): Promise<CatalogWindow | undefined> {
  const sessions: DesktopExternalSessionCatalogItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let targetSource: DesktopExternalSessionCatalogItem | undefined;

  do {
    const result = await window.maka.externalSessions.list(
      {
        adapterId: input.adapterId,
        includeArchived: input.includeArchived,
        ...(input.text ? { text: input.text } : {}),
        ...(cursor === undefined ? {} : { cursor }),
      },
      input.host,
    );
    if (!input.isCurrent()) return undefined;
    sessions.push(...result.sessions);
    targetSource ??= result.sessions.find(
      (session) => session.id === input.targetSourceSessionId,
    );
    const loadedWindowComplete = sessions.length >= input.minimumItemCount;
    const targetSearchComplete =
      input.targetSourceSessionId === undefined || targetSource !== undefined;
    if (result.nextCursor === null || (loadedWindowComplete && targetSearchComplete)) {
      return { sessions, nextCursor: result.nextCursor, targetSource };
    }
    if (seenCursors.has(result.nextCursor)) {
      throw new Error('External Session catalog repeated a cursor');
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  } while (true);
}

/**
 * One conversation this page has handed to Desktop Main.
 *
 * The record is carried rather than the row's id alone, because everything the
 * page has to say about an import — which one is running, which one came back
 * unconfirmed — has to stay true after the row is gone. The archived filter, a
 * source switch and a retry each replace the catalog, so a bare id is a pointer
 * into a list that is allowed to change underneath it. The adapter is part of
 * the record because a source-native id is unique only within its own source.
 */
type ImportAttempt = {
  adapterId: string;
  sourceSessionId: string;
  name: string;
  includeArchived: boolean;
  text: string;
  importedCountBefore: number;
  latestImportedSessionIdBefore: string | undefined;
  loadedCatalogItemCountBefore: number;
};

/**
 * The page's import activity.
 *
 * `single` is one row's 导入 button; `batch` is the selection's. They are one
 * state because they are one activity and cannot overlap — and `summary` is
 * what the last batch left behind, which no other slot on this page can hold.
 *
 * A batch runs SEQUENTIALLY, and not because the Host cannot take two: it
 * dedupes per (adapter, source id) and is happy to convert different
 * conversations at once. The reasons are here, on this page. Recovery re-reads
 * the whole catalog window an attempt came from, so overlapping attempts would
 * race that read; a progress count is only true when one thing is happening;
 * and the page has no useful answer to "which of these five failed" if they
 * fail together.
 */
type ImportRun =
  | { kind: 'idle'; summary?: ImportBatchOutcome }
  | { kind: 'single'; attempt: ImportAttempt }
  /** `current` is the one conversion actually in flight; the rest are queued. */
  | { kind: 'batch'; done: number; total: number; current?: string };

const IDLE_IMPORT_RUN: ImportRun = { kind: 'idle' };

/** What one row of a batch did. */
type ImportBatchDisposition = 'imported' | 'duplicated' | 'failed' | 'unknown';

/**
 * What a batch import can honestly say afterwards.
 *
 * `duplicated` is counted apart from `imported` because a row that already had
 * a copy is selectable on purpose — re-importing is how one is refreshed — but
 * a user who marked twelve and reads "imported 12" deserves to know that two of
 * them now exist twice.
 *
 * `unknown` is neither a success nor a failure: the call did not answer, and
 * only a catalog read settles whether the conversion landed. Folding it into
 * failures is what would invite the retry that makes a second copy.
 */
type ImportBatchOutcome = {
  imported: number;
  duplicated: number;
  failed: readonly string[];
  unknown: readonly string[];
};

const EMPTY_IMPORT_BATCH_OUTCOME: ImportBatchOutcome = {
  imported: 0,
  duplicated: 0,
  failed: [],
  unknown: [],
};

function recordImportBatchResult(
  outcome: ImportBatchOutcome,
  sourceSessionId: string,
  disposition: ImportBatchDisposition,
): ImportBatchOutcome {
  switch (disposition) {
    case 'imported':
      return { ...outcome, imported: outcome.imported + 1 };
    case 'duplicated':
      return { ...outcome, imported: outcome.imported + 1, duplicated: outcome.duplicated + 1 };
    case 'failed':
      return { ...outcome, failed: [...outcome.failed, sourceSessionId] };
    case 'unknown':
      return { ...outcome, unknown: [...outcome.unknown, sourceSessionId] };
  }
}

type ImportRecovery =
  | { kind: 'landed'; attempt: ImportAttempt; importedSessionId: string }
  | { kind: 'not_recorded'; attempt: ImportAttempt };

function isSameAttempt(
  attempt: ImportAttempt,
  adapterId: string | null,
  session: DesktopExternalSessionCatalogItem,
): boolean {
  return attempt.adapterId === adapterId && attempt.sourceSessionId === session.id;
}

/**
 * Settings · 活动 · 导入任务 — bring another local agent's conversations in as
 * Maka tasks.
 *
 * This used to be a rail row that opened a modal over the conversation. Import
 * is not navigation: it is a rare setup errand you do once per conversation you
 * care about, it needs a source, a filter and a paged directory to work
 * through, and none of that belongs in a 260px column of the tasks you are
 * actually working on. It sits beside 已归档任务 for the same reason that page
 * exists — both are about the task catalog rather than the task in front of
 * you.
 *
 * Reading the source directory is Desktop Main's job, so this page holds no
 * session state of its own: it lists through `window.maka.externalSessions` and
 * hands the imported `DesktopSessionSummary` back to the shell, which is what owns
 * navigating to it.
 *
 * Deliberately NOT here: keeping an imported task in sync with its source.
 * The importer is a one-shot conversion (`packages/storage/src/external-sessions.ts`)
 * and nothing behind it watches the source for changes; a "keep in sync"
 * control would be a promise no coordinator can keep.
 */
export function ImportTasksSettingsPage(props: {
  /** Hands the freshly imported task to the shell, which opens it. */
  onImported(session: DesktopSessionSummary): void;
  /** Opens the newest still-existing task previously imported from a row. */
  onOpenImported?(sessionId: string): void;
}) {
  const host = useRuntimeHostSettingsTarget();
  const locale = useUiLocale();
  const copy = getExternalSessionImportCopy(locale);
  const mountedRef = useMountedRef();
  const [adapterIds, setAdapterIds] = useState<string[]>([]);
  const [adapterId, setAdapterId] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  // Two states, not one: `searchDraft` is what the box shows, `search` is what
  // has been asked of the Host. Typing must not put a request on the wire per
  // keystroke against a source with a thousand sessions.
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [catalog, setCatalog] = useState<CatalogState>(EMPTY_CATALOG);
  /**
   * One probe, three phases — not two booleans that are always written
   * together. `sourceLoading && sourceResolved` was never a state this page
   * could be in, and nothing enforced that.
   */
  const [sourceProbe, setSourceProbe] = useState<'idle' | 'loading' | 'resolved'>('idle');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * What import work this page is doing, and what the last run said.
   *
   * One state, not three. A single import and a batch are the same activity —
   * a batch is a run of conversions the user asked for at once — and the
   * summary is what that activity leaves behind. Keeping them apart invited
   * combinations the page can never be in (a single import in flight while a
   * batch runs) and cost the page hook budget it does not have: the renderer
   * debt ledger refuses this file more stateful hooks than it already carries.
   *
   * Still at most one at a time, and still not because two conversions would
   * collide — Desktop Main dedupes per (adapter, source id) and takes both
   * happily. A single import ends by calling `onImported`, which closes
   * Settings and opens the new task; anything else running would be orphaned on
   * a page the user can no longer see. A batch stays here and reports instead,
   * which is why it can hold several conversions where a single one cannot.
   */
  const [importRun, setImportRun] = useState<ImportRun>(IDLE_IMPORT_RUN);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importRecovery, setImportRecovery] = useState<ImportRecovery | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [catalogPollTick, setCatalogPollTick] = useState(0);
  /**
   * Re-importing a conversation whose outcome is unknown is how you end up with
   * two copies of it, so its row stays disabled only while the authoritative
   * catalog recovery itself is unavailable. A successful recovery removes the
   * local lock and either exposes the landed task or allows a safe retry.
   */
  const [uncertainImports, setUncertainImports] = useState<readonly ImportAttempt[]>([]);
  /**
   * Rows marked for a batch. Always available: this page exists to pick
   * conversations out of a directory, so there is no mode to enter.
   */
  const [selection, setSelection] = useState(EMPTY_LISTED_SELECTION);

  // Only the newest list request may write. Switching source or toggling the
  // archived filter while a page is in flight would otherwise land the old
  // source's rows under the new source's label.
  const requestGeneration = useRef(0);
  const recoveryGeneration = useRef(0);
  // Last loaded catalog per selection key, so revisiting a source or filter is
  // instant. Read/written only inside the async loaders; never rendered
  // directly (the `catalog` state is what renders).
  const catalogCacheRef = useRef(new Map<string, CatalogState>());
  // Mirrors the committed `catalog` so a page append can extend the visible
  // window without threading it through a stale render closure.
  const catalogStateRef = useRef(catalog);
  useEffect(() => {
    catalogStateRef.current = catalog;
  }, [catalog]);
  const catalogSelectionRef = useRef({ adapterId, includeArchived, search, generation: 0 });
  if (
    catalogSelectionRef.current.adapterId !== adapterId ||
    catalogSelectionRef.current.includeArchived !== includeArchived ||
    catalogSelectionRef.current.search !== search
  ) {
    catalogSelectionRef.current = {
      adapterId,
      includeArchived,
      search,
      generation: catalogSelectionRef.current.generation + 1,
    };
  }

  // 250ms after typing stops, not per keystroke. The term reaches the adapter,
  // which walks every transcript on the source, so a request per character
  // would queue a thousand-file scan behind each one.
  useEffect(() => {
    if (searchDraft === search) return;
    const timer = setTimeout(() => setSearch(searchDraft), 250);
    return () => clearTimeout(timer);
  }, [searchDraft, search]);

  const loadSources = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setSourceProbe('loading');
    setSourceError(null);
    setCatalogError(null);
    setImportError(null);
    setAdapterIds([]);
    setAdapterId(null);
    // A different host (or locale-driven remount) is a different catalog space;
    // the cache keys carry neither, so drop everything rather than serve a
    // previous host's rows.
    catalogCacheRef.current.clear();
    setCatalog(EMPTY_CATALOG);
    try {
      const result = await window.maka.externalSessions.listSources(host);
      if (generation !== requestGeneration.current) return;
      setAdapterIds(result.adapterIds);
      setAdapterId(result.adapterIds[0] ?? null);
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setSourceError(localizedShellErrorMessage(error, copy.loadFailedFallback, locale));
    } finally {
      if (generation === requestGeneration.current) {
        setSourceProbe('resolved');
      }
    }
  }, [copy.loadFailedFallback, host, locale]);

  const loadCatalog = useCallback(
    async (sourceId: string, cursor?: string) => {
      const generation = ++requestGeneration.current;
      const append = cursor !== undefined;
      const key = catalogSelectionKey(sourceId, includeArchived, search);
      const cached = append ? undefined : catalogCacheRef.current.get(key);
      if (append) {
        setLoadingMore(true);
      } else if (cached !== undefined) {
        // Already loaded this selection once. Show it immediately and refresh in
        // the background instead of blanking to the spinner on every switch.
        setCatalog(cached);
        // Clear any spinner/Load More lock left by a superseded request. A
        // still-pending search or pagination load from the previous selection
        // will never reach its own `finally` reset (its generation is now
        // stale), so restoring cached rows without this would strand the
        // full-page spinner or a disabled Load More over an otherwise complete
        // view until this hit's background refresh happens to land.
        setCatalogLoading(false);
        setLoadingMore(false);
        setImportRecovery(null);
      } else {
        setCatalogLoading(true);
        setCatalog(EMPTY_CATALOG);
        setImportRecovery(null);
      }
      setCatalogError(null);
      setImportError(null);
      try {
        if (cached !== undefined) {
          // While a revisited selection still shows an import in flight, the 1s
          // import poll owns refreshing it. Starting our own readCatalogWindow
          // here would run a second read under the *same* request generation as
          // that poll, and a pre-import page read started here can land after a
          // newer poll result and snap "Imported once" back to "Importing…".
          // Leave the poll as the single refresher and keep the cached rows up.
          if (cached.sessions.some((session) => session.importState.isImporting)) {
            return;
          }
          // Refresh a revisited selection by re-reading the *whole* loaded
          // window, not just page one: the cache can be several pages deep from
          // Load More, and a bare first-page read here would overwrite it and
          // silently drop every page the user already paged in.
          const refreshed = await readCatalogWindow({
            adapterId: sourceId,
            includeArchived,
            text: search,
            minimumItemCount: cached.sessions.length,
            host,
            isCurrent: () => mountedRef.current && generation === requestGeneration.current,
          });
          if (refreshed === undefined) return;
          const next: CatalogState = {
            sessions: refreshed.sessions,
            nextCursor: refreshed.nextCursor,
          };
          writeCatalogCache(catalogCacheRef.current, key, next);
          setCatalog(next);
        } else {
          const result = await window.maka.externalSessions.list({
            adapterId: sourceId,
            includeArchived,
            ...(search ? { text: search } : {}),
            ...(cursor === undefined ? {} : { cursor }),
          }, host);
          if (generation !== requestGeneration.current) return;
          const next: CatalogState = {
            sessions: append
              ? [...catalogStateRef.current.sessions, ...result.sessions]
              : result.sessions,
            nextCursor: result.nextCursor,
          };
          writeCatalogCache(catalogCacheRef.current, key, next);
          setCatalog(next);
        }
      } catch (error) {
        if (generation !== requestGeneration.current) return;
        setCatalogError(localizedShellErrorMessage(error, copy.loadFailedFallback, locale));
      } finally {
        if (generation === requestGeneration.current) {
          setCatalogLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [copy.loadFailedFallback, host, includeArchived, locale, mountedRef, search],
  );

  const refreshLoadedCatalog = useCallback(
    async (sourceId: string, loadedItemCount: number) => {
      // Observe, don't preempt: the poll captures the current generation rather
      // than claiming a new one, so it defers to any in-flight authoritative
      // load/recovery instead of retiring that load's own catalogLoading reset.
      const generation = requestGeneration.current;
      try {
        const result = await readCatalogWindow({
          adapterId: sourceId,
          includeArchived,
          text: search,
          minimumItemCount: loadedItemCount,
          host,
          isCurrent: () => mountedRef.current && generation === requestGeneration.current,
        });
        if (result !== undefined) {
          const refreshed: CatalogState = {
            sessions: result.sessions,
            nextCursor: result.nextCursor,
          };
          writeCatalogCache(
            catalogCacheRef.current,
            catalogSelectionKey(sourceId, includeArchived, search),
            refreshed,
          );
          setCatalog(refreshed);
        }
      } catch {
        // Catalog polling is best-effort. Keep the last authoritative page
        // visible and retry rather than replacing it with a transient error.
      }
    },
    [host, includeArchived, mountedRef, search],
  );

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (adapterId === null) return;
    void loadCatalog(adapterId);
  }, [adapterId, includeArchived, search, loadCatalog]);

  const hasCatalogImportInFlight = catalog.sessions.some(
    (session) => session.importState.isImporting,
  );
  useEffect(() => {
    if (
      adapterId === null ||
      importRun.kind !== 'idle' ||
      catalogLoading ||
      loadingMore ||
      !hasCatalogImportInFlight
    ) {
      return;
    }
    const timeout = setTimeout(() => {
      void refreshLoadedCatalog(adapterId, catalog.sessions.length).finally(() => {
        if (mountedRef.current) setCatalogPollTick((tick) => tick + 1);
      });
    }, EXTERNAL_SESSION_IMPORT_POLL_MS);
    return () => clearTimeout(timeout);
  }, [
    importRun.kind,
    adapterId,
    catalog.sessions.length,
    catalogPollTick,
    catalogLoading,
    hasCatalogImportInFlight,
    loadingMore,
    mountedRef,
    refreshLoadedCatalog,
  ]);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(uiLocaleToIntlLocale(locale), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );

  /**
   * The page's only call into `externalSessions.import`.
   *
   * Both the row button and the batch go through here. That is a bridge-surface
   * fact as much as a tidiness one: the renderer debt ledger counts call sites
   * per file and forbids this page from gaining another, so a second literal
   * call was never an option — and a single place to convert one conversation
   * is what the two paths wanted anyway.
   */
  const requestImport = useCallback(
    (adapter: string, sourceSessionId: string) =>
      window.maka.externalSessions.import({ adapterId: adapter, sourceSessionId }, host),
    [host],
  );

  const recoverUnknownImport = useCallback(
    async (attempt: ImportAttempt) => {
      const generation = ++recoveryGeneration.current;
      setRecoveryLoading(true);
      try {
        const result = await readCatalogWindow({
          adapterId: attempt.adapterId,
          includeArchived: attempt.includeArchived,
          text: attempt.text,
          minimumItemCount: attempt.loadedCatalogItemCountBefore,
          targetSourceSessionId: attempt.sourceSessionId,
          host,
          isCurrent: () => mountedRef.current && generation === recoveryGeneration.current,
        });
        if (result === undefined) return;
        const recoveredSource = result.targetSource;
        if (recoveredSource === undefined) {
          throw new Error('External Session source disappeared during import recovery');
        }

        const recoveredState: CatalogState = {
          sessions: result.sessions,
          nextCursor: result.nextCursor,
        };
        // Always refresh the cache for the selection this attempt came from, even
        // if the user has since switched source or filter. Recovery has confirmed
        // the import landed; leaving the pre-import rows in the cache would greet
        // the user with an "Import" button (not "Import again") when they return,
        // inviting a duplicate import until a later background refresh corrects it.
        writeCatalogCache(
          catalogCacheRef.current,
          catalogSelectionKey(attempt.adapterId, attempt.includeArchived, attempt.text),
          recoveredState,
        );

        // Publish to screen whenever the user is currently viewing the same
        // selection tuple this attempt came from. Match the tuple, not the
        // generation captured at import time: navigating A→B→A lands back on the
        // same selection with a *newer* generation, and a generation check would
        // refuse to publish there — leaving a clickable "Import" on a row that
        // already imported until a slow background refresh happened to catch up.
        const currentSelection = catalogSelectionRef.current;
        if (
          currentSelection.adapterId === attempt.adapterId &&
          currentSelection.includeArchived === attempt.includeArchived &&
          currentSelection.search === attempt.text
        ) {
          // Recovery is the newest authoritative read for this exact catalog
          // selection. Retire an older poll/load-more/revisit response before
          // publishing it so that response cannot put pre-import state back up.
          requestGeneration.current += 1;
          setCatalogLoading(false);
          setLoadingMore(false);
          setCatalog(recoveredState);
        }
        setUncertainImports((current) =>
          current.filter(
            (entry) =>
              entry.adapterId !== attempt.adapterId ||
              entry.sourceSessionId !== attempt.sourceSessionId,
          ),
        );
        const recoveredSessionId = recoveredSource.importState.importedSessionIds[0];
        const landed =
          recoveredSessionId !== undefined &&
          (recoveredSource.importState.importedCount > attempt.importedCountBefore ||
            recoveredSessionId !== attempt.latestImportedSessionIdBefore);
        setImportRecovery(
          landed
            ? { kind: 'landed', attempt, importedSessionId: recoveredSessionId }
            : { kind: 'not_recorded', attempt },
        );
      } catch (error) {
        if (!mountedRef.current || generation !== recoveryGeneration.current) return;
        setUncertainImports((current) =>
          current.some(
            (entry) =>
              entry.adapterId === attempt.adapterId &&
              entry.sourceSessionId === attempt.sourceSessionId,
          )
            ? current
            : [...current, attempt],
        );
      } finally {
        if (mountedRef.current && generation === recoveryGeneration.current) {
          setRecoveryLoading(false);
        }
      }
    },
    [host, mountedRef],
  );

  const importConversation = useCallback(
    async (session: DesktopExternalSessionCatalogItem) => {
      if (adapterId === null || importRun.kind !== 'idle') return;
      const attempt: ImportAttempt = {
        adapterId,
        sourceSessionId: session.id,
        name: session.name,
        includeArchived,
        // The search term is part of the attempt for the same reason the
        // archived filter is: recovery re-reads the catalog window this row
        // came from, and a cleared box would look at a different list.
        text: search,
        importedCountBefore: session.importState.importedCount,
        latestImportedSessionIdBefore: session.importState.importedSessionIds[0],
        loadedCatalogItemCountBefore: catalog.sessions.length,
      };
      setImportRun({ kind: 'single', attempt });
      setImportError(null);
      setImportRecovery(null);
      try {
        const outcome = await requestImport(attempt.adapterId, attempt.sourceSessionId);
        // Navigating away from Settings unmounts this page while the import is
        // still in Desktop Main's hands. The conversion itself completes and is
        // stored either way; what must not happen is a completion from a page
        // the user has left steering the shell somewhere they did not ask for.
        if (!mountedRef.current) return;
        if (!outcome.ok) {
          await recoverUnknownImport(attempt);
          return;
        }
        props.onImported(outcome.session);
      } catch (error) {
        if (!mountedRef.current) return;
        setImportError(localizedShellErrorMessage(error, copy.importFailedFallback, locale));
      } finally {
        if (mountedRef.current) setImportRun(IDLE_IMPORT_RUN);
      }
    },
    [
      importRun.kind,
      adapterId,
      catalog.sessions.length,
      copy.importFailedFallback,
      locale,
      mountedRef,
      props,
      recoverUnknownImport,
      requestImport,
      includeArchived,
      search,
    ],
  );

  const listedSourceIds = useMemo(
    () => catalog.sessions.map((session) => session.id),
    [catalog.sessions],
  );
  /**
   * The marked rows that are still on screen — derived, not reconciled.
   *
   * A selection outlives the list it was made from: a search narrows, the
   * archived filter flips, a poll replaces the window. Intersecting at read
   * time answers that without an effect, so a stale id can never be counted,
   * confirmed, or imported even for the render between the catalog changing and
   * an effect catching up. It also leaves this page's hook budget alone, which
   * the renderer debt ledger will not let grow.
   */
  const marked = useMemo(
    () => pruneListedSelection(selection, listedSourceIds).selectedIds,
    [listedSourceIds, selection],
  );
  const masterState = listedSelectionMasterState({ selectedIds: marked }, listedSourceIds);

  const busy = importRun.kind !== 'idle';

  const importSelected = useCallback(async () => {
    if (adapterId === null || busy) return;
    // Frozen at the press, in the catalog's own order rather than the set's
    // insertion order, so the progress count walks the list the way the user
    // reads it.
    const targets = catalog.sessions.filter((session) => marked.has(session.id));
    if (targets.length === 0) return;
    setImportError(null);
    setImportRecovery(null);
    setImportRun({ kind: 'batch', done: 0, total: targets.length, current: targets[0]?.id });
    let outcome = EMPTY_IMPORT_BATCH_OUTCOME;
    try {
      for (const [index, session] of targets.entries()) {
        if (!mountedRef.current) return;
        const attempt: ImportAttempt = {
          adapterId,
          sourceSessionId: session.id,
          name: session.name,
          includeArchived,
          text: search,
          importedCountBefore: session.importState.importedCount,
          latestImportedSessionIdBefore: session.importState.importedSessionIds[0],
          loadedCatalogItemCountBefore: catalog.sessions.length,
        };
        // A row that already had a copy is selectable on purpose — re-importing
        // is how a conversation is refreshed — but the summary owes the user
        // the fact that it now exists twice.
        const wasImported = session.importState.importedCount > 0;
        try {
          const result = await requestImport(attempt.adapterId, attempt.sourceSessionId);
          if (!mountedRef.current) return;
          outcome = recordImportBatchResult(
            outcome,
            session.id,
            // Not `failed`: the call did not answer, and only a catalog read
            // settles whether the conversion landed. Calling it a failure is
            // what invites the retry that makes a second copy.
            result.ok ? (wasImported ? 'duplicated' : 'imported') : 'unknown',
          );
          if (!result.ok) {
            // Recorded, not recovered. A single import recovers inline, but
            // recovery re-reads the whole catalog window per attempt, and doing
            // that between conversions would interleave N full reads with the
            // batch and race the writes it is making. The unconfirmed banner
            // names every one of these and its 重试 resolves them a press at a
            // time, removing each as it settles.
            setUncertainImports((current) =>
              current.some(
                (entry) =>
                  entry.adapterId === attempt.adapterId &&
                  entry.sourceSessionId === attempt.sourceSessionId,
              )
                ? current
                : [...current, attempt],
            );
          }
        } catch {
          if (!mountedRef.current) return;
          // One rejection is not the batch's answer for every row after it. The
          // failure is recorded and the run continues; the summary names how
          // many did not go through.
          outcome = recordImportBatchResult(outcome, session.id, 'failed');
        }
        setImportRun({
          kind: 'batch',
          done: index + 1,
          total: targets.length,
          current: targets[index + 1]?.id,
        });
      }
    } finally {
      if (mountedRef.current) {
        setImportRun({ kind: 'idle', summary: outcome });
        // Cleared because it was answered. Leaving the rows marked after a run
        // invites a second press that would import each of them again.
        setSelection(EMPTY_LISTED_SELECTION);
        // Imported rows change their own description ("已导入 N 次"), and the
        // page has no other reason to re-read.
        void loadCatalog(adapterId);
      }
    }
  }, [
    adapterId,
    busy,
    catalog.sessions,
    includeArchived,
    loadCatalog,
    mountedRef,
    requestImport,
    search,
    marked,
  ]);

  const noSource = sourceProbe === 'resolved' && !sourceError && adapterIds.length === 0;
  const catalogEmpty =
    adapterId !== null && !catalogLoading && !catalogError && catalog.sessions.length === 0;
  // The shared normalizer decides what counts as a filter, so the empty-state
  // copy and the matcher cannot disagree about a whitespace-only box.
  const activeSearch = normalizeExternalSessionQueryText(search);

  if (sourceProbe === 'loading') {
    return (
      <SettingsPage>
        <div role="status" aria-live="polite">
          <HStack gap={2} vAlign="center" hAlign="center">
            <Spinner size="lg" />
            {copy.loading}
          </HStack>
        </div>
      </SettingsPage>
    );
  }

  if (sourceError) {
    return (
      <SettingsPage>
        <Banner
          status="error"
          title={copy.loadFailedTitle}
          description={sourceError}
          endContent={
            <Button variant="ghost" size="sm" label={copy.retry} onClick={() => void loadSources()} />
          }
        />
      </SettingsPage>
    );
  }

  // No adapter on this machine is the whole page: there is no source to pick,
  // no filter that would change anything, and nothing to list.
  if (noSource) {
    return (
      <SettingsPage>
        <EmptyState title={copy.unavailableTitle} description={copy.unavailableDescription} />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage as="section" aria-label={copy.listAria}>
      {/* One source is the common case — Codex is the only adapter that ships
          — and a segmented control with a single segment is a control nobody
          can operate. The description names the source instead, and the switch
          appears when there is actually something to switch between. */}
      <SettingsSection
        title={copy.sourceLabel}
        description={
          adapterIds.length === 1 && adapterId !== null
            ? sourceLabel(adapterId, copy.sourceNames)
            : undefined
        }
        variant="bare"
      >
        <VStack gap={3}>
          {adapterIds.length > 1 && adapterId !== null && (
            <SegmentedControl
              label={copy.sourceLabel}
              value={adapterId}
              layout="fill"
              size="sm"
              onChange={setAdapterId}
              isDisabled={catalogLoading}
            >
              {adapterIds.map((id) => (
                <SegmentedControlItem key={id} value={id} label={sourceLabel(id, copy.sourceNames)} />
              ))}
            </SegmentedControl>
          )}
          <TextInput
            label={copy.searchLabel}
            description={copy.searchHelp}
            placeholder={copy.searchPlaceholder}
            value={searchDraft}
            onChange={setSearchDraft}
            hasClear
          />
          <CheckboxInput
            label={copy.includeArchived}
            value={includeArchived}
            onChange={setIncludeArchived}
            isDisabled={catalogLoading}
          />
        </VStack>
      </SettingsSection>

      <SettingsSection description={copy.duplicateNote}>
        <VStack gap={3}>
          {catalogError && (
            <Banner
              status="error"
              title={copy.loadFailedTitle}
              description={catalogError}
              endContent={
                adapterId === null ? undefined : (
                  <Button
                    variant="ghost"
                    size="sm"
                    label={copy.retry}
                    onClick={() => void loadCatalog(adapterId)}
                  />
                )
              }
            />
          )}

          {importError && (
            <Banner status="error" title={copy.importFailedTitle} description={importError} />
          )}

          {/* Named here rather than only on its row, because the catalog is
              free to change while an import runs: filter it out, switch source,
              retry a failed page, and the row is gone. This is also what tells
              the user why every remaining 导入 is disabled. */}
          {importRun.kind === 'single' && (
            <div role="status" aria-live="polite">
              <Banner
                status="info"
                title={copy.importInProgressTitle}
                description={copy.importInProgressDescription(importRun.attempt.name)}
              />
            </div>
          )}

          {importRun.kind === 'batch' && (
            <div role="status" aria-live="polite">
              <Banner
                status="info"
                title={copy.importInProgressTitle}
                description={copy.batchProgress(importRun.done, importRun.total)}
              />
            </div>
          )}

          {/* The batch stays on this page and reports here, rather than
              navigating the way a single import does. There is no sensible task
              to open after importing twelve, and leaving would strand the rows
              that did not land. */}
          {importRun.kind === 'idle' && importRun.summary !== undefined && (
            <div role="status" aria-live="polite">
              <Banner
                status={importRun.summary.failed.length > 0 ? 'warning' : 'success'}
                title={
                  importRun.summary.imported > 0
                    ? copy.batchDoneTitle(importRun.summary.imported)
                    : copy.batchNothingImported
                }
                description={
                  [
                    importRun.summary.duplicated > 0
                      ? copy.batchDuplicated(importRun.summary.duplicated)
                      : null,
                    importRun.summary.failed.length > 0
                      ? copy.batchFailed(importRun.summary.failed.length)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined
                }
              />
            </div>
          )}

          {uncertainImports.length > 0 && (
            <Banner
              status="warning"
              title={copy.importOutcomeUnknownTitle}
              description={copy.importOutcomeUnknownDescription(
                uncertainImports.map((entry) => entry.name),
              )}
              endContent={
                <Button
                  variant="ghost"
                  size="sm"
                  label={copy.retry}
                  isLoading={recoveryLoading}
                  isDisabled={recoveryLoading}
                  onClick={() => void recoverUnknownImport(uncertainImports[0]!)}
                />
              }
            />
          )}

          {importRecovery?.kind === 'landed' && (
            <Banner
              status="success"
              title={copy.importRecoveredTitle}
              description={copy.importRecoveredDescription(importRecovery.attempt.name)}
              endContent={
                props.onOpenImported ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    label={copy.openLatestImportedTask}
                    onClick={() => props.onOpenImported?.(importRecovery.importedSessionId)}
                  />
                ) : undefined
              }
            />
          )}

          {importRecovery?.kind === 'not_recorded' && (
            <Banner
              status="info"
              title={copy.importNotRecordedTitle}
              description={copy.importNotRecordedDescription}
            />
          )}

          {catalogLoading && (
            <div role="status" aria-live="polite">
              <HStack gap={2} vAlign="center" hAlign="center">
                <Spinner size="lg" />
                {copy.loading}
              </HStack>
            </div>
          )}

          {/* A search that found nothing is not the same as a source with
              nothing in it. Reusing the "no conversations" copy would tell a
              user their transcripts are missing when the term is simply
              wrong, and hide the one control that would fix it. */}
          {/* Keyed on the normalized term, the same value the matcher uses.
              Comparing the raw string would call a box holding only spaces an
              active search and answer `No conversation has "   "` on a source
              that is simply empty. */}
          {catalogEmpty && activeSearch !== undefined && (
            <EmptyState
              isCompact
              title={copy.searchLabel}
              description={copy.searchEmpty(search.trim())}
            />
          )}
          {catalogEmpty && activeSearch === undefined && (
            <EmptyState isCompact title={copy.emptyTitle} description={copy.emptyDescription} />
          )}

          {catalog.sessions.length > 0 && (
            <HStack gap={2} vAlign="center" className="maka-import-selection-bar">
              <CheckboxInput
                label={copy.selectAllAriaLabel}
                isLabelHidden
                value={masterState}
                isDisabled={busy}
                // Plain checkbox semantics, including from the partial state:
                // an indeterminate box becomes ticked, which selects all. It is
                // what the platform does and what the Session rail's own master
                // box does, and one surface inventing a second rule for the
                // same control is worse than either rule.
                onChange={(checked) =>
                  setSelection(setAllListedSelected(listedSourceIds, checked))
                }
              />
              <span className="maka-import-selection-count" aria-live="polite">
                {copy.selectedCount(marked.size, listedSourceIds.length)}
              </span>
              <span className="maka-import-selection-spacer" />
              <Button
                variant="secondary"
                size="sm"
                label={copy.importSelected}
                isLoading={importRun.kind === 'batch'}
                isDisabled={busy || marked.size === 0}
                onClick={() => void importSelected()}
              />
            </HStack>
          )}

          {catalog.sessions.length > 0 && (
            <List
              density="balanced"
              hasDividers
              aria-label={copy.listAria}
              aria-busy={loadingMore || undefined}
            >
              {catalog.sessions.map((session) => {
                const timestamp = session.updatedAt ?? session.createdAt;
                const description = [
                  session.cwd,
                  timestamp !== undefined ? dateFormatter.format(timestamp) : null,
                  session.archived ? copy.archived : null,
                  session.importState.importedCount > 0
                    ? copy.importedCount(session.importState.importedCount)
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ');
                const isImporting =
                  session.importState.isImporting ||
                  (importRun.kind === 'single' &&
                    isSameAttempt(importRun.attempt, adapterId, session)) ||
                  // Only the conversion actually in flight. Marking every
                  // selected row would put a spinner on rows that are queued,
                  // and a spinner claims something is happening now.
                  (importRun.kind === 'batch' && importRun.current === session.id);
                const latestImportedSessionId = session.importState.importedSessionIds[0];
                const hasImported = session.importState.importedCount > 0;
                return (
                  <ListItem
                    key={session.id}
                    label={session.name}
                    description={description.length > 0 ? description : undefined}
                    startContent={
                      <HStack gap={2} vAlign="center">
                        {/* The box leads, in the same column as the master box
                            above it. The source icon stays: it says what kind of
                            thing the row is, which selecting does not. */}
                        <CheckboxInput
                          label={copy.selectRowAriaLabel(session.name)}
                          isLabelHidden
                          value={marked.has(session.id)}
                          isDisabled={busy || isImporting}
                          onChange={(checked) =>
                            setSelection((current) =>
                              toggleListedSelection(current, session.id, checked),
                            )
                          }
                        />
                        <MessageSquare size={ICON_SIZE.control} aria-hidden="true" />
                      </HStack>
                    }
                    endContent={
                      <HStack gap={2} vAlign="center">
                        {latestImportedSessionId !== undefined && props.onOpenImported && (
                          <Button
                            variant="ghost"
                            size="sm"
                            label={copy.openLatestImportedTask}
                            aria-label={copy.openLatestImportedTaskFor(session.name)}
                            onClick={() => props.onOpenImported?.(latestImportedSessionId)}
                          />
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          isLoading={isImporting}
                          isDisabled={
                            isImporting ||
                            busy ||
                            uncertainImports.length > 0
                          }
                          // `onClick`, not `clickAction`. Astryx runs
                          // `clickAction` inside a React 19 async transition, and
                          // React holds a transition's state updates until the
                          // action settles, so `setActiveImport` landed only once
                          // the import was already over and nothing on the page
                          // could tell that one was running. `clickAction` buys
                          // the clicked button its own pending state, and that is
                          // all it buys; this is a page fact, so the page owns it.
                          onClick={() => void importConversation(session)}
                          // Every row's button reads 导入; its purpose-specific
                          // label supplies the accessible name while `children`
                          // keeps the compact visible copy.
                          label={
                            isImporting
                              ? copy.importingTask(session.name)
                              : hasImported
                              ? copy.importTaskAgain(session.name)
                              : copy.importTask(session.name)
                          }
                        >
                          {isImporting ? copy.importing : hasImported ? copy.importAgain : copy.import}
                        </Button>
                      </HStack>
                    }
                  />
                );
              })}
            </List>
          )}

          {catalog.nextCursor !== null && adapterId !== null && (
            /* Full width and `secondary`: as a centred ghost label this read as
               a caption under the list rather than the control that extends it. */
            <Button
              variant="secondary"
              size="sm"
              width="100%"
              label={loadingMore ? copy.loadingMore : copy.loadMore}
              isDisabled={loadingMore}
              // `onClick` for the same reason as the row buttons: inside
              // `clickAction`'s transition `loadingMore` commits too late to
              // disable anything or to say 正在加载….
              onClick={() => void loadCatalog(adapterId, catalog.nextCursor ?? undefined)}
            />
          )}
        </VStack>
      </SettingsSection>
    </SettingsPage>
  );
}

function sourceLabel(adapterId: string, names: Readonly<Record<string, string>>): string {
  return names[adapterId] ?? adapterId;
}
