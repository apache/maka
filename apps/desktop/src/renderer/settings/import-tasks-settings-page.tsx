import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { List, ListItem } from '@astryxdesign/core/List';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { uiLocaleToIntlLocale } from '@maka/core/ui-locale';
import type { ExternalSessionSummary } from '@maka/core/external-session';
import type { DesktopSessionSummary } from '../../preload/bridge-contract.js';
import { Spinner, useMountedRef, useUiLocale } from '@maka/ui';
import { ICON_SIZE, MessageSquare } from '@maka/ui/icons';
import { getExternalSessionImportCopy } from '../locales/external-session-import-copy.js';
import { localizedShellErrorMessage } from '../locales/shell-copy.js';
import { SettingsPage, SettingsSection } from './settings-section';

type CatalogState = {
  sessions: ExternalSessionSummary[];
  nextCursor: string | null;
};

const EMPTY_CATALOG: CatalogState = { sessions: [], nextCursor: null };

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
};

function isSameAttempt(
  attempt: ImportAttempt,
  adapterId: string | null,
  session: ExternalSessionSummary,
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
 * hands the imported `SessionSummary` back to the shell, which is what owns
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
}) {
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
  /**
   * Re-importing a conversation whose outcome is unknown is how you end up with
   * two copies of it, so its row stays disabled for the rest of this page's
   * lifetime and the banner names it as the one to go look for.
   */
  const [uncertainImports, setUncertainImports] = useState<readonly ImportAttempt[]>([]);
  // Only the newest list request may write. Switching source or toggling the
  // archived filter while a page is in flight would otherwise land the old
  // source's rows under the new source's label.
  const requestGeneration = useRef(0);

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
      const result = await window.maka.externalSessions.listSources();
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
  }, [copy.loadFailedFallback, locale]);

  const loadCatalog = useCallback(
    async (sourceId: string, cursor?: string) => {
      const generation = ++requestGeneration.current;
      const append = cursor !== undefined;
      if (append) setLoadingMore(true);
      else {
        setCatalogLoading(true);
        setCatalog(EMPTY_CATALOG);
      }
      setCatalogError(null);
      setImportError(null);
      try {
        const result = await window.maka.externalSessions.list({
          adapterId: sourceId,
          includeArchived,
          ...(cursor === undefined ? {} : { cursor }),
        });
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
    [copy.loadFailedFallback, includeArchived, locale],
  );

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (adapterId === null) return;
    void loadCatalog(adapterId);
  }, [adapterId, includeArchived, loadCatalog]);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(uiLocaleToIntlLocale(locale), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );

  const importConversation = useCallback(
    async (session: ExternalSessionSummary) => {
      if (adapterId === null || activeImport !== null) return;
      const attempt: ImportAttempt = {
        adapterId,
        sourceSessionId: session.id,
        name: session.name,
      };
      setActiveImport(attempt);
      setImportError(null);
      try {
        const outcome = await window.maka.externalSessions.import({
          adapterId: attempt.adapterId,
          sourceSessionId: attempt.sourceSessionId,
        });
        // Navigating away from Settings unmounts this page while the import is
        // still in Desktop Main's hands. The conversion itself completes and is
        // stored either way; what must not happen is a completion from a page
        // the user has left steering the shell somewhere they did not ask for.
        if (!mountedRef.current) return;
        if (!outcome.ok) {
          setUncertainImports((current) => [...current, attempt]);
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
    [activeImport, adapterId, copy.importFailedFallback, locale, mountedRef, props],
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
                ]
                  .filter(Boolean)
                  .join(' · ');
                const isImporting =
                  activeImport !== null && isSameAttempt(activeImport, adapterId, session);
                return (
                  <ListItem
                    key={session.id}
                    label={session.name}
                    description={description.length > 0 ? description : undefined}
                    startContent={<MessageSquare size={ICON_SIZE.control} aria-hidden="true" />}
                    endContent={
                      <Button
                        variant="secondary"
                        size="sm"
                        isLoading={isImporting}
                        isDisabled={
                          activeImport !== null ||
                          uncertainImports.some((entry) =>
                            isSameAttempt(entry, adapterId, session),
                          )
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
                        label={isImporting ? copy.importing : copy.import}
                        // Every row's button reads 导入; only the accessible
                        // name can say which conversation it imports.
                        aria-label={copy.importTask(session.name)}
                      />
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
