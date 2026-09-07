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

import { useState } from 'react';
import type { WorkHubRailCopy } from '../../../locales/workhub-copy.js';
import type { UiLocale } from '@maka/core/ui-locale';
import { Button, dotForStatus, presentSessionStatus } from '@maka/ui';
import { List, ListItem, StatusDot } from '@astryxdesign/core';
import {
  deriveWorkHubAnchors,
  matchesWorkHubFilter,
  type WorkHubAnchorSession,
  type WorkHubWorkFilter,
} from '../model/anchor-rail.js';

export function WorkHubNavigationRail(props: {
  readonly locale: UiLocale;
  readonly sessions: readonly WorkHubAnchorSession[];
  readonly focusSessionId?: string;
  readonly delegatedSessionIds: readonly string[];
  readonly copy: WorkHubRailCopy;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const [filter, setFilter] = useState<WorkHubWorkFilter>('all');
  const anchors = deriveWorkHubAnchors({
    sessions: props.sessions,
    focusSessionId: props.focusSessionId,
    delegatedSessionIds: props.delegatedSessionIds,
    filter,
  });
  const matchingWorkCount = props.sessions.filter((session) =>
    matchesWorkHubFilter(session, filter)).length;

  return (
    <aside className="workhub-anchor-rail" aria-label={props.copy.workNavigation}>
      <div className="workhub-anchor-heading">
        <strong>{props.copy.work}</strong>
        <span>{props.copy.anchorCount(anchors.length, matchingWorkCount, props.sessions.length)}</span>
      </div>
      <div className="workhub-filters" role="toolbar" aria-label={props.copy.filterWork}>
        {props.copy.filters.map((candidate) => (
          <Button
            key={candidate.id}
            className="workhub-filter-button"
            variant={filter === candidate.id ? 'secondary' : 'ghost'}
            size="sm"
            label={candidate.label}
            aria-pressed={filter === candidate.id}
            onClick={() => setFilter(candidate.id)}
          />
        ))}
      </div>
      <nav aria-label={props.copy.workNavigation}>
        {anchors.length > 0 ? (
          <List className="workhub-anchors" density="compact" hasDividers>
            {anchors.map((anchor) => {
              const state = anchor.archived
                ? props.copy.archived
                : props.copy.states[anchor.state];
              const variant = anchor.archived
                ? dotForStatus('neutral')
                : presentSessionStatus(anchor.state, props.locale).variant;
              return (
                <ListItem
                  key={anchor.target.sessionId}
                  label={anchor.sessionName}
                  description={`${anchor.target.sessionId === props.focusSessionId ? props.copy.focused : anchor.projectName} · ${state}`}
                  startContent={variant ? <StatusDot variant={variant} label={state} /> : undefined}
                  isSelected={anchor.target.sessionId === props.focusSessionId}
                  aria-current={anchor.target.sessionId === props.focusSessionId ? 'page' : undefined}
                  onClick={() => props.onOpenSession(anchor.target.sessionId)}
                />
              );
            })}
          </List>
        ) : (
          <p className="workhub-anchor-empty">{props.copy.noFilteredWork}</p>
        )}
      </nav>
    </aside>
  );
}
