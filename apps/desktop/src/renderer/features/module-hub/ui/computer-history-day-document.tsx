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

import { useCallback, useEffect, useId, useReducer, useRef } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type { ComputerHistoryDetail, ComputerHistoryTimelineEntry } from '@maka/core/computer-history';
import { IconButton, useUiLocale } from '@maka/ui';
import { RefreshCcw } from '@maka/ui/icons';
import type { ModuleHubServices } from '../ports.js';
import { useModuleHubServices } from '../services-context.js';
import { computerHistoryCopy, localHistoryDay } from './computer-history-copy.js';
import { ComputerHistoryDocument } from './computer-history-document.js';
import { ComputerHistoryKeywords } from './computer-history-keywords.js';

type SavedDocument = NonNullable<ComputerHistoryDetail['document']>;
type ReadFailure = { kind: 'read'; message?: string } | { kind: 'missing' | 'noDocument' };
type DocumentRead = {
  revision: string;
  service: ModuleHubServices['computerHistory'];
  state: 'queued' | 'loading' | 'settled';
  document?: SavedDocument;
  failure?: ReadFailure;
};

const DAY_LABELS = {
  en: { rollup: '6-hour summary', crossDay: 'Cross-day' },
  'zh-CN': { rollup: '6 \u5c0f\u65f6\u6458\u8981', crossDay: '\u8de8\u65e5' },
  'zh-TW': { rollup: '6 \u5c0f\u6642\u6458\u8981', crossDay: '\u8de8\u65e5' },
};

function sourceRevision(entry: ComputerHistoryTimelineEntry): string {
  if (entry.documentRevision !== undefined) return `document:${entry.documentRevision}`;
  // Legacy entries lack a full-document revision; their preview can only detect visible changes.
  return JSON.stringify([
    entry.title, entry.description, entry.start, entry.end, entry.applications,
    entry.eventCount, entry.suppressedEventCount, entry.summaryLevel,
    entry.summaryChildren, entry.summaryText, entry.contextMarkdown,
    entry.keywords, entry.documentName,
    entry.suggestion?.type, entry.suggestion?.name, entry.suggestion?.description,
  ]);
}

export function ComputerHistoryDayDocument({ entries, onOpenEntry, onSearchKeyword }: {
  entries: readonly ComputerHistoryTimelineEntry[];
  onOpenEntry(entry: ComputerHistoryTimelineEntry): void;
  onSearchKeyword(keyword: string): void;
}) {
  const { computerHistory, clipboard } = useModuleHubServices();
  const locale = useUiLocale();
  const copy = computerHistoryCopy(locale);
  const labels = DAY_LABELS[locale];
  const sectionId = useId();
  const reads = useRef(new Map<string, DocumentRead>());
  const active = useRef(0);
  const mounted = useRef(false);
  const [, render] = useReducer((value: number) => value + 1, 0);

  const drain = useCallback(function drain() {
    if (!mounted.current) return;
    for (const [id, read] of reads.current) {
      if (active.current >= 4) break;
      if (read.state !== 'queued') continue;
      read.state = 'loading';
      active.current++;
      void (async () => {
        const isCurrent = () => mounted.current && reads.current.get(id) === read;
        try {
          const detail = await read.service.detail(id);
          if (!isCurrent()) return;
          read.document = detail?.document;
          read.failure = !detail ? { kind: 'missing' } : !detail.document ? { kind: 'noDocument' } : undefined;
        } catch (error) {
          if (isCurrent()) read.failure = { kind: 'read', message: error instanceof Error ? error.message : undefined };
        } finally {
          // Obsolete, non-cancellable IPC reads still occupy a slot until they actually finish.
          active.current--;
          if (isCurrent()) {
            read.state = 'settled';
            render();
          }
          drain();
        }
      })();
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const next = new Map<string, DocumentRead>();
    let changed = entries.length !== reads.current.size;
    for (const entry of entries) {
      const previous = reads.current.get(entry.id);
      const revision = sourceRevision(entry);
      if (previous?.revision === revision && previous.service === computerHistory) next.set(entry.id, previous);
      else {
        changed = true;
        next.set(entry.id, {
          revision, service: computerHistory, state: 'queued',
          document: previous?.service === computerHistory ? previous.document : undefined,
        });
      }
    }
    reads.current = next;
    drain();
    if (changed) render();
  }, [entries, computerHistory, drain]);

  function retry(id: string) {
    const read = reads.current.get(id);
    if (!read || read.state !== 'settled' || !read.failure) return;
    reads.current.set(id, { ...read, state: 'queued', failure: undefined });
    drain();
    render();
  }

  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const dateTime = new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return <div className="computer-history-day-document">
    {entries.map((entry, index) => {
      const previous = reads.current.get(entry.id);
      const read = previous?.service === computerHistory ? previous : undefined;
      const currentRevision = read?.revision === sourceRevision(entry);
      const loading = !read || !currentRevision || read.state !== 'settled';
      const crossDay = localHistoryDay(entry.start) !== localHistoryDay(entry.end);
      const format = crossDay ? dateTime : time;
      const titleId = `${sectionId}-${index}-title`;
      const descriptionId = `${sectionId}-${index}-description`;
      const failure = currentRevision ? read?.failure : undefined;
      const failureText = failure?.kind === 'read' ? failure.message
        : failure?.kind === 'missing' ? copy.missing : copy.noDocument;
      return <section className="computer-history-day-document-section" key={entry.id} aria-labelledby={titleId}>
        <header className="computer-history-day-document-header">
          <div className="computer-history-day-document-meta">
            <span className="computer-history-day-document-range">
              <time dateTime={entry.start}>{format.format(new Date(entry.start))}</time>
              {' - '}
              <time dateTime={entry.end}>{format.format(new Date(entry.end))}</time>
            </span>
            {entry.summaryLevel === '6h' ? <span>{labels.rollup}</span> : null}
            {crossDay ? <span>{labels.crossDay}</span> : null}
          </div>
          <h3 id={titleId} className="computer-history-day-document-title">
            <Button label={entry.title} variant="ghost" aria-describedby={descriptionId} onClick={() => onOpenEntry(entry)} />
          </h3>
          <p id={descriptionId} className="computer-history-day-document-description">{entry.description}</p>
          <ComputerHistoryKeywords keywords={entry.keywords} onSearch={onSearchKeyword} />
        </header>
        <div className="computer-history-day-document-content" aria-busy={loading}>
          {loading ? <div className="computer-history-day-document-loading" role="status">
            <span>{copy.loading}</span>
            {!read?.document ? <Skeleton height={80} width="100%" /> : null}
          </div> : null}
          {failure ? <div className="computer-history-day-document-error" role="alert">
            <span>{copy.documentFailed}{failureText ? `: ${failureText}` : ''}</span>
            <IconButton label={copy.refresh} tooltip={copy.refresh} icon={<RefreshCcw size={15} aria-hidden />} size="sm" variant="ghost" onClick={() => retry(entry.id)} />
          </div> : null}
          {read?.document ? <ComputerHistoryDocument
            document={read.document}
            headingLevel={4}
            onCopy={(text) => clipboard.writeText(text)}
            onReveal={() => computerHistory.revealSummary(entry.id)}
          /> : null}
        </div>
      </section>;
    })}
  </div>;
}
