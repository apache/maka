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

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { IconButton, dotForStatus, useRovingRowFocus, useUiLocale } from '@maka/ui';
import {
  ArrowLeft, ArrowRight, BookOpen, ChevronDown, ChevronRight, Clock,
  History, Pause, Pencil, Play, RefreshCcw, Search, Settings, Trash2, X,
} from '@maka/ui/icons';
import type {
  ComputerHistoryApplication, ComputerHistoryDetail, ComputerHistoryStatus, ComputerHistoryTimelineEntry,
} from '@maka/core/computer-history';
import { useComputerHistoryController } from '../controller/use-computer-history-controller.js';
import { useComputerHistoryApplications } from '../controller/use-computer-history-applications.js';
import { useModuleHubServices } from '../services-context.js';
import {
  computerHistoryCopy, filterHistoryEntries, historyAppName, historySuggestionDraft, intersectHistoryDays, localHistoryDay, shiftHistoryDay,
} from './computer-history-copy.js';
import { ComputerHistoryAppIcon } from './computer-history-app-icon.js';
import { ComputerHistoryDocument } from './computer-history-document.js';
import { useHistorySettingsFocus } from './use-history-settings-focus.js';
import { groupHistoryEntries, type HistoryGranularity, type HistoryViewGroup } from './computer-history-view.js';
import { ComputerHistoryDayDocument } from './computer-history-day-document.js';

export function ComputerHistoryPage({ onCreateDraft, onOpenSettings: showSettings, isObscured }: {
  onCreateDraft(text: string): void;
  onOpenSettings(): void;
  isObscured: boolean;
}) {
  const locale = useUiLocale();
  const copy = computerHistoryCopy(locale);
  const { clipboard, computerHistory } = useModuleHubServices();
  const [day, setDay] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [granularity, setGranularity] = useState<HistoryGranularity>(() => computerHistory.getViewGranularity());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collection, setCollection] = useState<{ start: string; kind: '6h' | 'day'; rollupIds: readonly string[] } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [tab, setTab] = useState('evidence');
  const [expandedEvents, setExpandedEvents] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [deleteTarget, setDeleteTarget] = useState<ComputerHistoryTimelineEntry | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const controller = useComputerHistoryController(detailOpen ? selectedId : null);
  const { status, service, run, busy, loading } = controller;
  const entries = useMemo(() => controller.entries.filter((entry) => entry.summaryLevel), [controller.entries]);
  const listRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const wasObscured = useRef(isObscured);
  const { capture: captureSettingsFocus, restore: restoreSettingsFocus } = useHistorySettingsFocus();
  function onOpenSettings() {
    captureSettingsFocus();
    showSettings();
  }
  const roving = useRovingRowFocus(listRef);
  const panelId = useId();
  const today = localHistoryDay(new Date());
  const applications = useMemo(() =>
    [...new Set(entries.flatMap((entry) => entry.applications))].sort((a, b) => a.localeCompare(b)), [entries]);
  const days = useMemo(() => [...new Set(entries.flatMap((entry) => intersectHistoryDays(entry)))].sort().reverse(), [entries]);
  const applicationMetadata = useComputerHistoryApplications([
    ...applications, ...(status?.settings.blockedApplications ?? []),
  ]);
  const appName = (app: string) => historyAppName(app, applicationMetadata.applications.get(app)?.name);
  const filtered = useMemo(() => filterHistoryEntries(entries, day, query, source, applicationMetadata.applications), [entries, day, query, source, applicationMetadata.applications]);
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const groups = useMemo(() => groupHistoryEntries(entries, filtered, granularity)
    .filter((group) => !day || granularity !== 'day' || group.day === day), [entries, filtered, granularity, day]);
  const selectedCollection = useMemo(() => {
    if (!collection) return null;
    const matches = groupHistoryEntries(entries, entries, collection.kind)
      .filter((group) => group.start === collection.start);
    if (!matches.length) return null;
    // Keep opened fallback rollups and window identity through filter/provenance changes.
    const documents = new Map(matches.flatMap((group) => group.entries).map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      if (collection.rollupIds.includes(entry.id)) documents.set(entry.id, entry);
    }
    return { ...matches[0], entries: [...documents.values()]
      .sort((a, b) => Date.parse(b.start) - Date.parse(a.start) || a.id.localeCompare(b.id)) };
  }, [entries, collection]);
  const latest = useMemo(() => entries.filter((entry) => entry.summaryLevel === '10min')
    .reduce<string | undefined>((end, entry) => !end || entry.end > end ? entry.end : end, undefined), [entries]);
  const detail = controller.detail?.entry.id === selectedId ? controller.detail : null;
  const time = (value: string, seconds = false) => new Intl.DateTimeFormat(locale, {
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
  }).format(new Date(value));
  const formatDay = (value: string) => new Intl.DateTimeFormat(locale, {
    month: 'long', day: 'numeric', weekday: 'short',
  }).format(new Date(`${value}T12:00:00`));
  const groupLabel = (value: string) => value === today ? copy.today
    : value === shiftHistoryDay(today, -1) ? copy.yesterday : formatDay(value);
  const rangeLabel = (start: string, end: string) => localHistoryDay(start) === localHistoryDay(end)
    ? `${groupLabel(localHistoryDay(start))} · ${time(start)}–${time(end)}`
    : `${groupLabel(localHistoryDay(start))} ${time(start)}–${groupLabel(localHistoryDay(end))} ${time(end)}`;
  const collectionLabel = (group: HistoryViewGroup) => group.kind === 'day'
    ? `${formatDay(group.day)} · ${copy.dailyActivities}` : rangeLabel(group.start, group.end);
  const shownEvents = detail?.events.slice(0, expandedEvents ? 100 : 5) ?? [];
  const hasFilters = Boolean(query || source || day);
  const firstRun = status && !status.settings.enabled && !status.settings.summariesEnabled && status.eventCount === 0;
  const summariesOff = status && !status.settings.summariesEnabled;
  const recordingBlocked = status && !['running', 'stopped', 'paused'].includes(status.state);
  const emptyTitle = hasFilters ? copy.noMatch
    : status?.summaryError ? copy.summaryError
      : recordingBlocked ? copy.states[status.state]
        : firstRun ? copy.firstRun
          : summariesOff ? copy.summaryOff
            : status?.summaryState === 'running' ? copy.summaryRunning
              : status?.state === 'paused' ? copy.states.paused
                : status?.state === 'stopped' ? copy.states.stopped : copy.summaryWaiting;
  const emptyHelp = hasFilters ? copy.noMatchHelp
    : status?.summaryError ? copy.summaryErrorHelp
      : recordingBlocked ? copy.summaryBlockedHelp
        : firstRun ? copy.firstHelp
          : summariesOff ? copy.summaryOffHelp
            : status?.summaryState === 'running' ? copy.summaryWaitingHelp
              : status?.state === 'paused' ? copy.summaryPausedHelp
                : status?.state === 'stopped' ? copy.summaryStoppedHelp : copy.summaryWaitingHelp;

  useEffect(() => {
    if (wasObscured.current && !isObscured) {
      restoreSettingsFocus();
      applicationMetadata.refresh();
      void controller.refresh(true);
    }
    wasObscured.current = isObscured;
  }, [isObscured, controller.refresh, applicationMetadata.refresh, restoreSettingsFocus]);

  useEffect(() => {
    if (!loading && selectedId !== null && !entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(null);
      setDetailOpen(false);
    }
    if (!loading && collection && !selectedCollection) {
      setCollection(null);
      setDetailOpen(false);
    }
  }, [entries, selectedId, loading, collection, selectedCollection]);

  useEffect(() => {
    setExpandedEvents(false);
    setEvidenceOpen(false);
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [selectedId, collection, detailOpen]);

  function changeGranularity(value: string) {
    if (value !== '10min' && value !== '6h' && value !== 'day') return;
    setGranularity(value);
    computerHistory.setViewGranularity(value);
    if (listRef.current) listRef.current.scrollTop = 0;
  }

  function chooseEntry(entry: ComputerHistoryTimelineEntry, group?: HistoryViewGroup) {
    setCollection(null);
    setSelectedId(entry.id);
    setDetailOpen(true);
    setTab('evidence');
    if (group) setExpandedGroups((previous) => new Map(previous).set(group.id, true));
    requestAnimationFrame(() => detailRef.current?.focus({ preventScroll: true }));
  }

  function chooseGroup(group: HistoryViewGroup) {
    if (group.summary) {
      chooseEntry(group.summary);
      return;
    }
    if (group.kind === '10min') return;
    setSelectedId(null);
    setCollection({ start: group.start, kind: group.kind,
      rollupIds: group.entries.filter((entry) => entry.summaryLevel === '6h').map((entry) => entry.id) });
    setDetailOpen(true);
    requestAnimationFrame(() => detailRef.current?.focus({ preventScroll: true }));
  }

  function entryRow(entry: ComputerHistoryTimelineEntry, group: HistoryViewGroup) {
    const crossDay = localHistoryDay(group.start) !== localHistoryDay(new Date(Date.parse(group.end) - 1));
    return <ListItem key={entry.id} isSelected={entry.id === selectedId} className="computer-history-row"
      onClick={() => chooseEntry(entry, group)} label={<span className="computer-history-row-content">
        <time className="computer-history-row-time" dateTime={entry.start} title={rangeLabel(entry.start, entry.end)}>
          {crossDay ? <span>{groupLabel(localHistoryDay(entry.start))}</span> : null}
          {time(entry.start)}<span>{time(entry.end)}</span>
        </time>
        <span className="computer-history-row-rail" aria-hidden><i /></span>
        <span className="computer-history-row-body">
          <span className="computer-history-row-title">{entry.title}</span>
          <span className="computer-history-row-description">{entry.description}</span>
          {entryApps(entry.applications)}
        </span>
      </span>} />;
  }

  function entryApps(apps: readonly string[]) {
    return <span className="computer-history-apps">{apps.slice(0, 5).map((app) =>
      <span key={app} title={appName(app)} aria-label={appName(app)}><ComputerHistoryAppIcon application={app} metadata={applicationMetadata.applications.get(app)} /></span>,
    )}{apps.length > 5 ? <span>+{apps.length - 5}</span> : null}</span>;
  }

  function backToList() {
    setDetailOpen(false);
    requestAnimationFrame(() => {
      const target = listRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"] button, button[aria-current="true"]')
        ?? listRef.current?.querySelector<HTMLButtonElement>('button');
      target?.focus({ preventScroll: true });
    });
  }

  async function deleteHistory() {
    const target = deleteTarget;
    if (!target || busy) return;
    // The action becomes disabled while deleting; retain focus on Cancel.
    deleteDialogRef.current?.querySelector<HTMLButtonElement>('button[data-autofocus]')?.focus({ preventScroll: true });
    const success = await run(() => service.deleteEntry(target.id));
    if (success) {
      setDeleteTarget(null);
      setDraft(null);
      setDetailOpen(false);
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('li button')?.focus());
    }
  }

  return (
    <section className="computer-history-page" aria-label={copy.title} data-detail-open={detailOpen && (selected !== null || selectedCollection !== null)}>
      <header className="computer-history-header">
        <div className="computer-history-heading">
          <div className="computer-history-title"><History size={21} aria-hidden /><Heading level={1}>{copy.title}</Heading><span>{copy.local}</span></div>
        </div>
        <div className="computer-history-header-actions">
          <div className="computer-history-status" role="status">
            {status ? <><StatusDot label={copy.states[status.state]} variant={dotForStatus(historyStatusSemantic(status.state))} /><span>{copy.states[status.state]}</span></> : <span>{copy.loading}</span>}
          </div>
          {status?.state === 'running' ? (
            <IconButton label={copy.pause} icon={<Pause size={16} aria-hidden />} size="sm" isDisabled={busy} onClick={() => void run(() => service.pause(), { preserveDetail: true })} />
          ) : status?.state === 'paused' ? (
            <IconButton label={copy.resume} icon={<Play size={16} aria-hidden />} size="sm" isDisabled={busy} onClick={() => void run(() => service.resume(), { preserveDetail: true })} />
          ) : null}
          <IconButton label={copy.refresh} icon={<RefreshCcw size={16} aria-hidden />} size="sm" isDisabled={loading || busy} onClick={() => { applicationMetadata.refresh(); void controller.refresh(); }} />
          <IconButton label={copy.settings} icon={<Settings size={16} aria-hidden />} size="sm" onClick={onOpenSettings} />
        </div>
      </header>

      <div className="computer-history-viewbar">
        <span>{copy.granularity}</span>
        <SegmentedControl label={copy.granularity} size="sm" value={granularity} onChange={changeGranularity}>
          <SegmentedControlItem value="10min" label={copy.tenMinutes} />
          <SegmentedControlItem value="6h" label={copy.sixHours} />
          <SegmentedControlItem value="day" label={copy.oneDay} />
        </SegmentedControl>
        {latest ? <time className="computer-history-freshness" dateTime={latest} title={rangeLabel(latest, latest)}>
          {copy.summarizedThrough} {localHistoryDay(latest) === today ? time(latest) : `${groupLabel(localHistoryDay(latest))} ${time(latest)}`}
        </time> : null}
      </div>

      {entries.length > 0 || query || source || day ? <div className="computer-history-filters">
        <div className="computer-history-search"><TextInput label={copy.search} isLabelHidden placeholder={copy.search} startIcon={<Search size={16} aria-hidden />} value={query} hasClear onChange={setQuery} /></div>
        <Selector label={copy.date} isLabelHidden width={148} value={day} options={[{ value: '', label: copy.allDays }, ...days.map((value) => ({ value, label: formatDay(value) }))]} onChange={setDay} />
        <Selector label={copy.source} isLabelHidden width={160} hasSearch value={source} options={[{ value: '', label: copy.allSources }, ...applications.map((app) => ({ value: app, label: appName(app) }))]} onChange={setSource} />
      </div> : null}

      {status?.state === 'needs_permission' ? <div className="computer-history-notice" role="status"><span>{copy.permissionHelp}</span><Button label={copy.repair} variant="ghost" size="sm" onClick={onOpenSettings} /></div> : null}

      {controller.error || status?.error ? <div className="computer-history-error" role="alert"><span>{controller.error ?? status?.error}</span></div> : null}
      {status?.summaryError ? (
        <div className="computer-history-error" role="alert"><span>{copy.summaryError}: {status.summaryError}</span><Button label={copy.retry} size="sm" variant="ghost" isDisabled={busy || !status.settings.summariesEnabled} onClick={() => void run(() => service.retrySummary(), { preserveDetail: true })} /></div>
      ) : null}
      {entries.length > 0 && status?.summaryState === 'running' ? <div className="computer-history-notice" role="status">{copy.summaryRunning}</div> : null}
      {detail && controller.detailError ? (
        <div className="computer-history-error" role="alert"><span>{copy.detailFailed}: {controller.detailError}</span><Button label={copy.refresh} size="sm" variant="ghost" isDisabled={busy || loading} onClick={() => void controller.refresh()} /></div>
      ) : null}

      <div className="computer-history-workspace">
        <aside className="computer-history-master" aria-label={copy.list} ref={listRef} {...roving} aria-busy={loading}>
          {loading && entries.length === 0 ? Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="computer-history-list-skeleton"><Skeleton width="34%" height={12} /><Skeleton width="88%" height={16} /><Skeleton width="60%" height={12} /></div>
          )) : groups.map((group) => {
            const expanded = expandedGroups.get(group.id) ?? (granularity === '10min' || !group.summary && granularity === '6h');
            const label = granularity === '10min' || granularity === 'day' ? groupLabel(group.day) : rangeLabel(group.start, group.end);
            return <section className="computer-history-day" key={group.id}>
              {granularity === '10min' ? <h2 className="computer-history-list-heading">
                <Button variant="ghost" label={`${label} ${group.entries.length} ${copy.activities}`}
                  icon={expanded ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
                  aria-expanded={expanded} aria-controls={`${panelId}-${group.id}`}
                  onClick={() => setExpandedGroups((previous) => new Map(previous).set(group.id, !expanded))}>
                  <span>{label}</span><span className="computer-history-day-count">{group.entries.length} {copy.activities}</span>
                </Button>
              </h2> : <div className="computer-history-group-header">
                <IconButton label={`${expanded ? copy.collapseActivities : copy.expandActivities} · ${label}`}
                  tooltip={expanded ? copy.collapseActivities : copy.expandActivities} size="sm" variant="ghost"
                  icon={expanded ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
                  aria-expanded={expanded} aria-controls={`${panelId}-${group.id}`} isDisabled={group.entries.length === 0}
                  onClick={() => setExpandedGroups((previous) => new Map(previous).set(group.id, !expanded))} />
                <button className="computer-history-group-open" type="button"
                  aria-current={group.summary?.id === selectedId || !group.summary && collection?.kind === group.kind && collection.start === group.start ? 'true' : undefined}
                  onClick={() => chooseGroup(group)}>
                  <span className="computer-history-group-meta"><span>{label}</span>{group.entries.length ? <span>{group.entries.length} {copy.activities}</span> : null}</span>
                  {group.summary ? <>
                    <span className="computer-history-row-title">{group.summary.title}</span>
                    <span className="computer-history-row-description">{group.summary.description}</span>
                    {entryApps(group.summary.applications)}
                  </> : granularity === 'day' ? <>
                    <span className="computer-history-row-title">{collectionLabel(group)}</span>
                    <span className="computer-history-row-description">{group.entries.slice(0, 3).map((entry) => entry.title).join(' · ')}</span>
                    {entryApps([...new Set(group.entries.flatMap((entry) => entry.applications))])}
                  </> : <span className="computer-history-pending"><Clock size={13} aria-hidden />{copy.overviewPending}</span>}
                </button>
              </div>}
              <List id={`${panelId}-${group.id}`} className={`computer-history-list${granularity !== '10min' ? ' computer-history-children' : ''}`} density="spacious">
                {expanded ? group.entries.map((entry) => entryRow(entry, group)) : null}
              </List>
            </section>;
          })}
          {!loading && groups.length === 0 && !controller.error ? (
            <div className="computer-history-empty"><EmptyState headingLevel={2}
              title={emptyTitle}
              description={emptyHelp}
              icon={<History size={24} aria-hidden />}
              actions={hasFilters ? <Button label={copy.reset} variant="ghost" size="sm" onClick={() => { setQuery(''); setSource(''); setDay(''); }} />
                : !status?.summaryError && (firstRun || summariesOff || recordingBlocked || status?.state === 'stopped') ? <Button label={firstRun ? copy.setup : copy.settings} icon={<Settings size={15} aria-hidden />} variant="primary" size="sm" onClick={onOpenSettings} /> : undefined} /></div>
          ) : null}
        </aside>

        {detailOpen && selected ? <section className="computer-history-detail" ref={detailRef} tabIndex={-1} aria-label={selected.title}>
              <div className="computer-history-reader-toolbar">
                <Button className="computer-history-mobile-back" label={copy.back} icon={<ArrowLeft size={16} aria-hidden />} variant="ghost" size="sm" onClick={backToList} />
                <div className="computer-history-reader-actions"><Button label={copy.addToChat} icon={<Pencil size={14} aria-hidden />} size="sm" variant="ghost" isDisabled={busy} onClick={() => setDraft(selected.contextMarkdown)} />
                <IconButton label={copy.remove} size="sm" icon={<Trash2 size={15} aria-hidden />} isDisabled={busy} onClick={() => setDeleteTarget(selected)} />
                <IconButton label={copy.closeDetail} size="sm" icon={<X size={16} aria-hidden />} onClick={backToList} /></div>
              </div>
              <div className="computer-history-detail-content">
                <div className="computer-history-detail-meta"><Clock size={15} aria-hidden /><span>{rangeLabel(selected.start, selected.end)}</span><span>{Math.max(1, Math.round((Date.parse(selected.end) - Date.parse(selected.start)) / 60_000))} {copy.minutes}</span></div>
                <Heading level={2}>{selected.title}</Heading>
                <p className="computer-history-description">{selected.description}</p>
                <div className="computer-history-detail-meta computer-history-detail-apps">
                  {selected.applications.map((app) => <span className="computer-history-app-name" key={app} title={app}><ComputerHistoryAppIcon application={app} metadata={applicationMetadata.applications.get(app)} size={24} />{appName(app)}</span>)}
                  <span>{selected.eventCount} {copy.records}</span>
                  <span>{selected.summaryLevel ? copy.modelSummary : copy.rawGroup}</span>
                </div>
                {selected.summaryLevel ? (
                  <div aria-busy={controller.detailLoading}>
                    {controller.detailLoading ? <div className="computer-history-detail-skeleton"><Skeleton height={28} width="100%" /><Skeleton height={16} width="45%" /><Skeleton height={80} width="100%" /></div>
                      : controller.detailError && !detail ? <EmptyState headingLevel={3} title={copy.documentFailed} description={controller.detailError} actions={<Button label={copy.refresh} size="sm" variant="ghost" onClick={() => void controller.refresh()} />} />
                        : detail?.document ? <ComputerHistoryDocument key={selected.id} document={detail.document} onCopy={(text) => clipboard.writeText(text)} onReveal={() => service.revealSummary(selected.id)} />
                          : <EmptyState headingLevel={3} title={copy.missing} isCompact />}
                  </div>
                ) : <Text type="supporting" color="secondary">{copy.noDocument}</Text>}
                {selected.summaryLevel ? <Text type="supporting" color="secondary">{copy.modelNote}</Text> : null}
                <Collapsible className="computer-history-evidence" isOpen={evidenceOpen} onOpenChange={setEvidenceOpen} trigger={<span className="computer-history-evidence-label"><span>{copy.evidenceDisclosure}</span><span>{selected.eventCount} {copy.records}</span></span>}>
                  {evidenceOpen ? <>
                  <TabList role="tablist" aria-label={copy.evidence} value={tab} onChange={setTab} hasDivider>
                    <Tab id={`${panelId}-events-tab`} value="evidence" label={copy.evidence} panelId={`${panelId}-events`} />
                    <Tab id={`${panelId}-sources-tab`} value="sources" label={copy.sources} panelId={`${panelId}-sources`} />
                  </TabList>
                  <div role="tabpanel" id={`${panelId}-${tab === 'evidence' ? 'events' : 'sources'}`} aria-labelledby={`${panelId}-${tab === 'evidence' ? 'events' : 'sources'}-tab`} tabIndex={0} aria-busy={controller.detailLoading}>
                    {controller.detailLoading ? <div className="computer-history-detail-skeleton">{[0, 1, 2].map((index) => <Skeleton key={index} width="100%" height={56} />)}</div>
                      : controller.detailError && !detail ? <EmptyState headingLevel={3} title={copy.detailFailed} description={controller.detailError} icon={<History size={22} aria-hidden />} actions={<Button label={copy.refresh} size="sm" variant="ghost" onClick={() => void controller.refresh()} />} />
                        : !detail ? <EmptyState headingLevel={3} title={copy.missing} isCompact />
                          : tab === 'evidence' ? (
                            !detail.rawAvailable ? <EmptyState headingLevel={3} title={copy.expired} description={copy.expiredHelp} icon={<Clock size={22} aria-hidden />} /> : (
                              <>
                                <ol className="computer-history-events">{shownEvents.map((event) => (
                                  <li key={event.id}><time dateTime={event.timestamp}>{time(event.timestamp, true)}</time><div><span className="computer-history-event-title"><ComputerHistoryAppIcon application={event.application} metadata={applicationMetadata.applications.get(event.application)} />{copy.eventKinds[event.kind] ?? event.kind}</span><span>{historyAppName(event.application, applicationMetadata.applications.get(event.application)?.name, event.applicationName)}</span>{event.windowTitle ? <span className="computer-history-window">{event.windowTitle}</span> : null}</div></li>
                                ))}</ol>
                                <div className="computer-history-event-footer"><Text type="supporting" color="secondary">{shownEvents.length} {copy.shown} / {detail.eventTotal} {copy.total}. {copy.evidenceHelp}</Text>{detail.events.length > 5 ? <Button label={expandedEvents ? copy.showLess : copy.showMore} size="sm" variant="ghost" onClick={() => setExpandedEvents(!expandedEvents)} /> : null}</div>
                              </>
                            )
                          ) : (
                            <HistorySources detail={detail} status={status} applications={applicationMetadata.applications} />
                          )}
                  </div>
                  </> : null}
                </Collapsible>
                {selected.suggestion ? <section className="computer-history-suggestion" aria-label={copy.suggestion}>
                  <BookOpen size={17} aria-hidden /><div><Heading level={3}>{copy.suggestion} · {selected.suggestion.name}</Heading><p>{selected.suggestion.description}</p><Button label={copy.viewSuggestion} endContent={<ArrowRight size={14} aria-hidden />} variant="ghost" size="sm" isDisabled={busy} onClick={() => setDraft(historySuggestionDraft(selected, locale))} /></div>
                </section> : null}
              </div>
        </section> : null}
        {detailOpen && selectedCollection ? <section className="computer-history-detail" ref={detailRef} tabIndex={-1} aria-label={collectionLabel(selectedCollection)}>
          <div className="computer-history-reader-toolbar">
            <Button className="computer-history-mobile-back" label={copy.back} icon={<ArrowLeft size={16} aria-hidden />} variant="ghost" size="sm" onClick={backToList} />
            <span className="computer-history-collection-kind">{copy.savedActivities}</span>
            <IconButton label={copy.closeDetail} size="sm" icon={<X size={16} aria-hidden />} onClick={backToList} />
          </div>
          <div className="computer-history-detail-content">
            <div className="computer-history-detail-meta"><Clock size={15} aria-hidden /><span>{selectedCollection.entries.length} {copy.activities}</span></div>
            <Heading level={2}>{collectionLabel(selectedCollection)}</Heading>
            <ComputerHistoryDayDocument entries={selectedCollection.entries} onOpenEntry={chooseEntry} />
          </div>
        </section> : null}
      </div>
      <footer className="computer-history-footer"><span>{copy.retained}</span><span>{copy.summariesRetained}</span>{applicationMetadata.error ? <span role="status" title={applicationMetadata.error}>{copy.iconsFailed}</span> : null}</footer>

      <AlertDialog ref={deleteDialogRef} isOpen={deleteTarget !== null} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }} title={copy.removeTitle} description={`${deleteTarget?.title ?? ''}\n\n${copy.removeDescription}${controller.error ? `\n\n${controller.error}` : ''}`} cancelLabel={copy.cancel} actionLabel={copy.confirm} isActionLoading={busy} onAction={() => void deleteHistory()} />
      <Dialog isOpen={draft !== null} onOpenChange={(open) => { if (!open) setDraft(null); }} width={680} purpose="form">
        <Layout
          header={<DialogHeader title={copy.draftTitle} onOpenChange={(open) => { if (!open) setDraft(null); }} />}
          content={<LayoutContent><div className="computer-history-draft"><TextArea label={copy.draftLabel} value={draft ?? ''} rows={12} onChange={setDraft} /><Text type="supporting" color="secondary">{copy.draftHelp}</Text></div></LayoutContent>}
          footer={<LayoutFooter><div className="computer-history-draft-actions"><Button label={copy.cancel} variant="ghost" onClick={() => setDraft(null)} /><Button label={copy.insert} icon={<Pencil size={15} aria-hidden />} variant="primary" isDisabled={!draft?.trim() || busy} onClick={() => { if (draft?.trim()) { onCreateDraft(draft); setDraft(null); } }} /></div></LayoutFooter>}
        />
      </Dialog>
    </section>
  );
}

function HistorySources({ detail, status, applications }: {
  detail: ComputerHistoryDetail; status: ComputerHistoryStatus | null;
  applications: ReadonlyMap<string, ComputerHistoryApplication>;
}) {
  const copy = computerHistoryCopy(useUiLocale());
  return <ul className="computer-history-sources">{detail.entry.applications.map((application) => {
    const events = detail.events.filter((event) => event.application === application);
    const windows = [...new Set(events.flatMap((event) => event.windowTitle ? [event.windowTitle] : []))];
    const excluded = status?.settings.blockedApplications.includes(application) ?? false;
    return <li key={application}><ComputerHistoryAppIcon application={application} metadata={applications.get(application)} size={24} /><div><h3>{historyAppName(application, applications.get(application)?.name, events[0]?.applicationName)}</h3><code>{application}</code>{excluded ? <Text type="supporting" color="secondary">{copy.excluded}</Text> : null}{windows.length ? <ul>{windows.map((title) => <li key={title}>{title}</li>)}</ul> : <Text type="supporting" color="secondary">{copy.noWindows}</Text>}</div></li>;
  })}</ul>;
}

function historyStatusSemantic(state: ComputerHistoryStatus['state']) {
  if (state === 'running') return 'active';
  if (state === 'paused' || state === 'needs_permission') return 'attention';
  if (state === 'error' || state === 'unavailable') return 'error';
  return 'neutral';
}
