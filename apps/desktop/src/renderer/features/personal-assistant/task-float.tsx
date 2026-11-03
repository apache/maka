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
import { ChevronLeft, ChevronRight, Minus, ChevronDown } from '@maka/ui/icons';
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
  useEffect(() => watchFloatTasks(() => readFloatTasks(services, sessionId), result => {
    setOffline(result === null);
    setTasks(result ?? []);
  }), [services, sessionId]);
  const visibleTasks = visibleFloatTasks(tasks, showArchived);
  const pages = Math.max(1, Math.ceil(visibleTasks.length / 3));
  const currentPage = Math.min(page, pages - 1);
  const running = tasks.filter(task => task.phase === 'running').length;
  const waiting = tasks.filter(task => task.phase === 'waiting').length;
  const other = tasks.filter(task => ['queued', 'attention'].includes(task.phase));
  const countText = offline ? copy.offline : `${running} ${copy.phase.running} · ${waiting} ${copy.phase.waiting}${other.length ? ` · ${other.length} ${copy.phase.attention}` : ''}`;
  if (!tasks.length && !offline) return null;
  const time = (task: FloatTask) => task.updatedAt ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(task.updatedAt) : '—';
  return <aside className={`assistant-task-float${expanded ? '' : ' is-collapsed'}`} aria-label={copy.tasks}>
    {!expanded ? <Button variant="ghost" className="assistant-task-pill" onClick={() => setExpanded(true)} aria-label={`${copy.expand}: ${countText}`} label={countText} icon={<span className="assistant-task-brand">m</span>} endContent={<ChevronDown size={14} />} /> : <>
      <header><span className="assistant-task-brand">m</span><strong>Maka</strong><Button variant="ghost" size="sm" isIconOnly label={copy.collapse} onClick={() => setExpanded(false)} tooltip={copy.collapse} icon={<Minus size={15} />} /></header>
      <div className="assistant-task-counts" role="status">{countText}</div>
      <div className="assistant-task-list">
        {offline ? <p className="assistant-task-empty">{copy.offline}</p> : !visibleTasks.length ? <p className="assistant-task-empty">{copy.empty}</p> : visibleTasks.slice(currentPage * 3, currentPage * 3 + 3).map(task => <div key={task.id} className="assistant-task-row">
          <span className="assistant-task-heading"><strong title={task.title}>{task.title}</strong><time dateTime={task.updatedAt ? new Date(task.updatedAt).toISOString() : undefined} title={task.updatedAt ? `${copy.updated}: ${new Date(task.updatedAt).toLocaleString(locale)}` : copy.unknown}>{time(task)}</time></span>
          <span className={`assistant-task-progress is-${task.phase}`}><i aria-hidden="true" /><span title={`${copy.phase[task.phase]}${task.progress ? ` · ${task.progress}` : ''}`}><b>{copy.phase[task.phase]}</b>{task.progress ? ` · ${task.progress}` : ''}</span></span>
        </div>)}
      </div>
      <footer><Button variant="ghost" size="sm" label={showArchived ? copy.hideArchived : copy.showArchived} className="assistant-task-completed-toggle" aria-pressed={showArchived} onClick={() => { setShowArchived(!showArchived); setPage(0); }} /><nav aria-label={copy.tasks}><Button variant="ghost" size="sm" isIconOnly label={copy.previous} isDisabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} icon={<ChevronLeft size={13} />} /><span>{currentPage + 1}/{pages}</span><Button variant="ghost" size="sm" isIconOnly label={copy.next} isDisabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)} icon={<ChevronRight size={13} />} /></nav></footer>
    </>}
  </aside>;
}
