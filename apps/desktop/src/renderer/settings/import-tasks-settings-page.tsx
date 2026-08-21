import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { List, ListItem } from '@astryxdesign/core/List';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { uiLocaleToIntlLocale } from '@maka/core/ui-locale';
import type {
  DesktopRuntimeHostRef,
  DesktopSessionSummary,
} from '../../preload/bridge-contract.js';
import { Spinner, useMountedRef, useUiLocale } from '@maka/ui';
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

type CatalogWindow = CatalogState & {
  targetSource: DesktopExternalSessionCatalogItem | undefined;
};

async function readCatalogWindow(input: {
  adapterId: string;
  includeArchived: boolean;
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
  importedCountBefore: number;
  latestImportedSessionIdBefore: string | undefined;
  loadedCatalogItemCountBefore: number;
  catalogSelectionGeneration: number;
};

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
  const [catalog, setCatalog] = useState<CatalogState>(EMPTY_CATALOG);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceResolved, setSourceResolved] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * At most one import at a time. Not because two conversions would collide —
   * Desktop Main can take both — but because the first one to succeed calls
   * `onImported`, which closes Settings and opens the new task, orphaning any
   * other import on a page the user can no longer see.
   */
  const [activeImport, setActiveImport] = useState<ImportAttempt | null>(null);
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
  // Only the newest list request may write. Switching source or toggling the
  // archived filter while a page is in flight would otherwise land the old
  // source's rows under the new source's label.
  const requestGeneration = useRef(0);
  const recoveryGeneration = useRef(0);
  const catalogSelectionRef = useRef({ adapterId, includeArchived, generation: 0 });
  if (
    catalogSelectionRef.current.adapterId !== adapterId ||
    catalogSelectionRef.current.includeArchived !== includeArchived
  ) {
    catalogSelectionRef.current = {
      adapterId,
      includeArchived,
      generation: catalogSelectionRef.current.generation + 1,
    };
  }

  const loadSources = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setSourceLoading(true);
    setSourceResolved(false);
    setSourceError(null);
    setCatalogError(null);
    setImportError(null);
    setAdapterIds([]);
    setAdapterId(null);
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
        setSourceLoading(false);
        setSourceResolved(true);
      }
    }
  }, [copy.loadFailedFallback, host, locale]);

  const loadCatalog = useCallback(
    async (sourceId: string, cursor?: string) => {
      const generation = ++requestGeneration.current;
      const append = cursor !== undefined;
      if (append) setLoadingMore(true);
      else {
        setCatalogLoading(true);
        setCatalog(EMPTY_CATALOG);
        setImportRecovery(null);
      }
      setCatalogError(null);
      setImportError(null);
      try {
        const result = await window.maka.externalSessions.list({
          adapterId: sourceId,
          includeArchived,
          ...(cursor === undefined ? {} : { cursor }),
        }, host);
        if (generation !== requestGeneration.current) return;
        setCatalog((current) => ({
          sessions: append ? [...current.sessions, ...result.sessions] : result.sessions,
          nextCursor: result.nextCursor,
        }));
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
    [copy.loadFailedFallback, host, includeArchived, locale],
  );

  const refreshLoadedCatalog = useCallback(
    async (sourceId: string, loadedItemCount: number) => {
      const generation = ++requestGeneration.current;
      try {
        const result = await readCatalogWindow({
          adapterId: sourceId,
          includeArchived,
          minimumItemCount: loadedItemCount,
          host,
          isCurrent: () => mountedRef.current && generation === requestGeneration.current,
        });
        if (result !== undefined) setCatalog(result);
      } catch {
        // Catalog polling is best-effort. Keep the last authoritative page
        // visible and retry rather than replacing it with a transient error.
      }
    },
    [host, includeArchived, mountedRef],
  );

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (adapterId === null) return;
    void loadCatalog(adapterId);
  }, [adapterId, includeArchived, loadCatalog]);

  const hasCatalogImportInFlight = catalog.sessions.some(
    (session) => session.importState.isImporting,
  );
  useEffect(() => {
    if (
      adapterId === null ||
      activeImport !== null ||
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
    activeImport,
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

  const recoverUnknownImport = useCallback(
    async (attempt: ImportAttempt) => {
      const generation = ++recoveryGeneration.current;
      setRecoveryLoading(true);
      try {
        const result = await readCatalogWindow({
          adapterId: attempt.adapterId,
          includeArchived: attempt.includeArchived,
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

        const currentSelection = catalogSelectionRef.current;
        if (
          currentSelection.adapterId === attempt.adapterId &&
          currentSelection.includeArchived === attempt.includeArchived &&
          currentSelection.generation === attempt.catalogSelectionGeneration
        ) {
          // Recovery is the newest authoritative read for this exact catalog
          // selection. Retire an older poll/load-more response before publishing
          // it so that response cannot put pre-import state back on screen.
          requestGeneration.current += 1;
          setCatalogLoading(false);
          setLoadingMore(false);
          setCatalog(result);
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
      if (adapterId === null || activeImport !== null) return;
      const attempt: ImportAttempt = {
        adapterId,
        sourceSessionId: session.id,
        name: session.name,
        includeArchived,
        importedCountBefore: session.importState.importedCount,
        latestImportedSessionIdBefore: session.importState.importedSessionIds[0],
        loadedCatalogItemCountBefore: catalog.sessions.length,
        catalogSelectionGeneration: catalogSelectionRef.current.generation,
      };
      setActiveImport(attempt);
      setImportError(null);
      setImportRecovery(null);
      try {
        const outcome = await window.maka.externalSessions.import({
          adapterId: attempt.adapterId,
          sourceSessionId: attempt.sourceSessionId,
        }, host);
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
        if (mountedRef.current) setActiveImport(null);
      }
    },
    [
      activeImport,
      adapterId,
      catalog.sessions.length,
      copy.importFailedFallback,
      host,
      locale,
      mountedRef,
      props,
      recoverUnknownImport,
      includeArchived,
    ],
  );

  const noSource = sourceResolved && !sourceLoading && !sourceError && adapterIds.length === 0;
  const catalogEmpty =
    adapterId !== null && !catalogLoading && !catalogError && catalog.sessions.length === 0;

  if (sourceLoading) {
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
            ? sourceLabel(adapterId, copy.codex)
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
                <SegmentedControlItem key={id} value={id} label={sourceLabel(id, copy.codex)} />
              ))}
            </SegmentedControl>
          )}
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
          {activeImport !== null && (
            <div role="status" aria-live="polite">
              <Banner
                status="info"
                title={copy.importInProgressTitle}
                description={copy.importInProgressDescription(activeImport.name)}
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

          {catalogEmpty && (
            <EmptyState isCompact title={copy.emptyTitle} description={copy.emptyDescription} />
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
                  (activeImport !== null && isSameAttempt(activeImport, adapterId, session));
                const latestImportedSessionId = session.importState.importedSessionIds[0];
                const hasImported = session.importState.importedCount > 0;
                return (
                  <ListItem
                    key={session.id}
                    label={session.name}
                    description={description.length > 0 ? description : undefined}
                    startContent={<MessageSquare size={ICON_SIZE.control} aria-hidden="true" />}
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
                            activeImport !== null ||
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

function sourceLabel(adapterId: string, codexLabel: string): string {
  return adapterId === 'codex' ? codexLabel : adapterId;
}
