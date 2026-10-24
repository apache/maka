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

import { useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { useUiLocale } from '@maka/ui';
import { ChevronLeft, ChevronRight, Minus, ChevronDown, ArrowLeft } from '@maka/ui/icons';
import { usePersonalAssistantServices } from './services.js';
import { readFloatTasks, watchFloatTasks } from './task-float-source.js';
import { taskFloatCopy } from './task-float-copy.js';
import { visibleFloatTasks, type FloatTask } from './task-float-model.js';

export function PersonalAssistantTaskFloat({ sessionId }: { sessionId: string }) {
  const services = usePersonalAssistantServices();
  const locale = useUiLocale();
  const copy = taskFloatCopy[locale];
  const [tasks, setTasks] = useState<FloatTask[]>([]);
  const [offline, setOffline] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => watchFloatTasks(() => readFloatTasks(services, sessionId), result => {
    setOffline(result === null);
    setTasks(result ?? []);
  }), [services, sessionId]);
  const visibleTasks = visibleFloatTasks(tasks, showArchived);
  const pages = Math.max(1, Math.ceil(visibleTasks.length / 3));
  const currentPage = Math.min(page, pages - 1);
  const selected = visibleTasks.find(task => task.id === selectedId);
  const running = tasks.filter(task => task.phase === 'running').length;
  const waiting = tasks.filter(task => task.phase === 'waiting').length;
  const other = tasks.filter(task => ['queued', 'attention'].includes(task.phase));
  const countText = offline ? copy.offline : `${running} ${copy.phase.running} · ${waiting} ${copy.phase.waiting}${other.length ? ` · ${other.length} ${copy.phase.attention}` : ''}`;
  if (!tasks.length && !offline) return null;
  const time = (task: FloatTask) => task.updatedAt ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(task.updatedAt) : '—';
  return <aside className={`assistant-task-float${expanded ? '' : ' is-collapsed'}`} aria-label={copy.tasks}>
    <header>
      <span className="assistant-task-brand" aria-hidden="true">m</span>
      <div className="assistant-task-identity">
        <strong>{copy.tasks}</strong>
        <div className="assistant-task-counts" role="status" aria-label={countText}>
          {offline ? copy.offline : <>
            <span>{running} {copy.phase.running}</span>
            <span>{waiting} {copy.phase.waiting}</span>
            {other.length > 0 && <span>{other.length} {copy.phase.attention}</span>}
          </>}
        </div>
      </div>
      <Button variant="ghost" size="sm" isIconOnly
        label={expanded ? copy.collapse : copy.expand} aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)} tooltip={expanded ? copy.collapse : copy.expand}
        icon={expanded ? <Minus size={14} /> : <ChevronDown size={14} />} />
    </header>
    {expanded && <>
      <div className="assistant-task-list">
        {offline ? <p className="assistant-task-empty">{copy.offline}</p> : selected ? <div className="assistant-task-detail"><Button variant="ghost" size="sm" className="assistant-task-back" onClick={() => setSelectedId(null)} label={copy.back} icon={<ArrowLeft size={12} />} /><strong>{selected.title}</strong><small>{copy.phase[selected.phase]} · {time(selected)}</small><p>{selected.progress}</p></div> : !visibleTasks.length ? <p className="assistant-task-empty">{copy.empty}</p> : visibleTasks.slice(currentPage * 3, currentPage * 3 + 3).map(task => <Button variant="ghost" label={`${task.title} · ${copy.phase[task.phase]}`} key={task.id} className="assistant-task-row" onClick={() => setSelectedId(task.id)}>
          <span className="assistant-task-heading"><strong title={task.title}>{task.title}</strong><time dateTime={task.updatedAt ? new Date(task.updatedAt).toISOString() : undefined} title={task.updatedAt ? `${copy.updated}: ${new Date(task.updatedAt).toLocaleString(locale)}` : copy.unknown}>{time(task)}</time></span>
          <span className={`assistant-task-progress is-${task.phase}`}><i aria-hidden="true" /><span title={`${copy.phase[task.phase]}${task.progress ? ` · ${task.progress}` : ''}`}><b>{copy.phase[task.phase]}</b>{task.progress ? ` · ${task.progress}` : ''}</span></span>
        </Button>)}
      </div>
      {!selected && <footer><Button variant="ghost" size="sm" label={showArchived ? copy.hideArchived : copy.showArchived} className="assistant-task-completed-toggle" aria-pressed={showArchived} onClick={() => { setShowArchived(!showArchived); setPage(0); setSelectedId(null); }} /><nav aria-label={copy.tasks}><Button variant="ghost" size="sm" isIconOnly label={copy.previous} isDisabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} icon={<ChevronLeft size={13} />} /><span>{currentPage + 1}/{pages}</span><Button variant="ghost" size="sm" isIconOnly label={copy.next} isDisabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)} icon={<ChevronRight size={13} />} /></nav></footer>}
    </>}
  </aside>;
}
