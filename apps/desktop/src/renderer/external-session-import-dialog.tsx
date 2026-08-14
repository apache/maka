import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Item } from '@astryxdesign/core/Item';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { uiLocaleToIntlLocale } from '@maka/core/ui-locale';
import { type ExternalSessionSummary } from '@maka/core/external-session';
import { type SessionSummary } from '@maka/core/session';
import { Spinner, useUiLocale } from '@maka/ui';
import { ICON_SIZE, Upload } from '@maka/ui/icons';
import { getExternalSessionImportCopy } from './locales/external-session-import-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import { ExternalSessionImportLifecycle } from './external-session-import-lifecycle.js';

type CatalogState = {
  sessions: ExternalSessionSummary[];
  nextCursor: string | null;
};

const EMPTY_CATALOG: CatalogState = { sessions: [], nextCursor: null };

export function ExternalSessionImportDialog(props: {
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  onImported(session: SessionSummary): void;
}) {
  const locale = useUiLocale();
  const copy = getExternalSessionImportCopy(locale);
  const [adapterIds, setAdapterIds] = useState<string[]>([]);
  const [adapterId, setAdapterId] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [catalog, setCatalog] = useState<CatalogState>(EMPTY_CATALOG);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceResolved, setSourceResolved] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [importing, setImporting] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [uncertainSourceId, setUncertainSourceId] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const importLifecycle = useRef(new ExternalSessionImportLifecycle());
  const isOpenRef = useRef(props.isOpen);
  isOpenRef.current = props.isOpen;

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
    setSelectedId(null);
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
        setSelectedId(null);
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
    if (!props.isOpen) {
      requestGeneration.current += 1;
      importLifecycle.current.invalidate();
      setSourceResolved(false);
      setSourceLoading(false);
      setCatalogLoading(false);
      setLoadingMore(false);
      setImporting(false);
      setAdapterIds([]);
      setAdapterId(null);
      setCatalog(EMPTY_CATALOG);
      setSelectedId(null);
      setSourceError(null);
      setCatalogError(null);
      setImportError(null);
      setUncertainSourceId(null);
      return;
    }
    void loadSources();
  }, [loadSources, props.isOpen]);

  useEffect(() => {
    if (!props.isOpen || adapterId === null) return;
    void loadCatalog(adapterId);
  }, [adapterId, includeArchived, loadCatalog, props.isOpen]);

  useEffect(
    () => () => {
      importLifecycle.current.invalidate();
    },
    [],
  );

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(uiLocaleToIntlLocale(locale), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );

  const importSelected = useCallback(async () => {
    if (
      adapterId === null ||
      selectedId === null ||
      importing ||
      !importLifecycle.current.canClose()
    ) {
      return;
    }
    const requestToken = importLifecycle.current.begin();
    setImporting(true);
    setImportError(null);
    try {
      const outcome = await window.maka.externalSessions.import({
        adapterId,
        sourceSessionId: selectedId,
      });
      if (!isOpenRef.current || !importLifecycle.current.isCurrent(requestToken)) return;
      if (!outcome.ok) {
        setUncertainSourceId(selectedId);
        return;
      }
      props.onImported(outcome.session);
      props.onOpenChange(false);
    } catch (error) {
      if (!isOpenRef.current || !importLifecycle.current.isCurrent(requestToken)) return;
      setImportError(localizedShellErrorMessage(error, copy.importFailedFallback, locale));
    } finally {
      if (importLifecycle.current.finish(requestToken)) setImporting(false);
    }
  }, [adapterId, copy.importFailedFallback, importing, locale, props, selectedId]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !importLifecycle.current.canClose()) return;
      props.onOpenChange(open);
    },
    [props.onOpenChange],
  );

  const noSource = sourceResolved && !sourceLoading && !sourceError && adapterIds.length === 0;
  const catalogEmpty =
    adapterId !== null && !catalogLoading && !catalogError && catalog.sessions.length === 0;

  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={handleOpenChange}
      purpose="form"
      width={640}
      maxHeight="calc(100dvh - 96px)"
      className="maka-external-session-import-dialog"
    >
      <Layout
        height="fill"
        header={
          <DialogHeader
            startContent={<Upload size={ICON_SIZE.chrome} aria-hidden="true" />}
            title={copy.title}
            onOpenChange={handleOpenChange}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text type="body" color="secondary">
                {copy.description}
              </Text>

              {adapterIds.length > 0 && adapterId !== null && (
                <div className="maka-external-session-import-source">
                  <SegmentedControl
                    className="maka-external-session-import-source-list"
                    label={copy.sourceLabel}
                    value={adapterId}
                    layout="fill"
                    size="sm"
                    onChange={(value) => setAdapterId(value)}
                  >
                    {adapterIds.map((id) => (
                      <SegmentedControlItem
                        key={id}
                        value={id}
                        label={sourceLabel(id, copy.codex)}
                      />
                    ))}
                  </SegmentedControl>
                </div>
              )}

              {adapterIds.length > 0 && (
                <CheckboxInput
                  label={copy.includeArchived}
                  value={includeArchived}
                  onChange={setIncludeArchived}
                  isDisabled={catalogLoading || importing}
                />
              )}

              {sourceLoading && (
                <div className="maka-external-session-import-loading" role="status" aria-live="polite">
                  <Spinner size="lg" />
                  <Text type="supporting" color="secondary">
                    {copy.loading}
                  </Text>
                </div>
              )}

              {sourceError && (
                <Banner
                  status="error"
                  title={copy.loadFailedTitle}
                  description={sourceError}
                  endContent={<Button variant="ghost" size="sm" label={copy.retry} onClick={() => void loadSources()} />}
                />
              )}

              {noSource && (
                <EmptyState isCompact title={copy.unavailableTitle} />
              )}

              {catalogError && (
                <Banner
                  status="error"
                  title={copy.loadFailedTitle}
                  description={catalogError}
                  endContent={
                    adapterId === null ? undefined : (
                      <Button variant="ghost" size="sm" label={copy.retry} onClick={() => void loadCatalog(adapterId)} />
                    )
                  }
                />
              )}

              {importError && (
                <Banner status="error" title={copy.importFailedTitle} description={importError} />
              )}

              {uncertainSourceId !== null && (
                <Banner
                  status="warning"
                  title={copy.importOutcomeUnknownTitle}
                  description={copy.importOutcomeUnknownDescription}
                />
              )}

              {catalogLoading && (
                <div className="maka-external-session-import-loading" role="status" aria-live="polite">
                  <Spinner size="lg" />
                  <Text type="supporting" color="secondary">
                    {copy.loading}
                  </Text>
                </div>
              )}

              {catalogEmpty && (
                <EmptyState isCompact title={copy.emptyTitle} />
              )}

              {catalog.sessions.length > 0 && (
                <div
                  className="maka-external-session-import-list"
                  role="group"
                  aria-label={copy.title}
                  aria-busy={loadingMore || undefined}
                >
                  {catalog.sessions.map((session) => {
                    const timestamp = session.updatedAt ?? session.createdAt;
                    const meta = [
                      session.cwd,
                      timestamp !== undefined ? dateFormatter.format(timestamp) : null,
                      session.archived ? copy.archived : null,
                    ].filter(Boolean).join(' · ');
                    return (
                      <Item
                        key={session.id}
                        className="maka-external-session-import-row"
                        label={session.name}
                        description={meta}
                        isSelected={selectedId === session.id}
                        onClick={() => {
                          setSelectedId(session.id);
                          setImportError(null);
                        }}
                      />
                    );
                  })}
                </div>
              )}

              {catalog.nextCursor !== null && adapterId !== null && (
                <HStack hAlign="center">
                  <Button
                    variant="ghost"
                    size="sm"
                    label={loadingMore ? copy.loadingMore : copy.loadMore}
                    isDisabled={loadingMore}
                    onClick={() => void loadCatalog(adapterId, catalog.nextCursor ?? undefined)}
                  />
                </HStack>
              )}

              {adapterIds.length > 0 && (
                <Text type="supporting" size="sm" color="secondary">
                  {copy.duplicateNote}
                </Text>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                variant="ghost"
                label={copy.cancel}
                isDisabled={importing}
                onClick={() => handleOpenChange(false)}
              />
              <Button
                variant="primary"
                label={importing ? copy.importing : copy.import}
                isDisabled={
                  selectedId === null || importing || selectedId === uncertainSourceId
                }
                isLoading={importing}
                onClick={() => void importSelected()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

function sourceLabel(adapterId: string, codexLabel: string): string {
  return adapterId === 'codex' ? codexLabel : adapterId;
}
