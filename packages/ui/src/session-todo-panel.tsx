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

import { Banner, EmptyState, IconButton, Spinner } from '@astryxdesign/core';
import type { SessionTodoItem, SessionTodoStatus } from '@maka/core/session-todo';
import { CheckCircle2, CircleGauge, Clock, ICON_SIZE, ListTodo, RefreshCcw } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

const STATUS_ICONS = {
  pending: Clock,
  in_progress: CircleGauge,
  completed: CheckCircle2,
} satisfies Record<SessionTodoStatus, typeof Clock>;

export interface SessionTodoPanelProps {
  items: readonly SessionTodoItem[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}

export function sessionTodoActiveCount(items: readonly SessionTodoItem[]): number {
  return items.filter((item) => item.status !== 'completed').length;
}

/** Read-only flat projection of the Host-owned current Todo document. */
export function SessionTodoPanel(props: SessionTodoPanelProps) {
  const copy = getSharedUiCopy(useUiLocale()).sessionTodo;
  return (
    <section className="maka-task-ledger-panel" aria-label={copy.ariaLabel}>
      {props.error ? (
        <Banner
          status="error"
          role="alert"
          className="maka-task-ledger-message"
          title={props.error}
          endContent={props.onRetry ? (
            <IconButton
              variant="ghost"
              size="sm"
              className="maka-task-ledger-retry"
              onClick={props.onRetry}
              label={copy.retry}
              tooltip={copy.retry}
              icon={<RefreshCcw size={ICON_SIZE.control} aria-hidden="true" />}
            />
          ) : undefined}
        />
      ) : props.loading && props.items.length === 0 ? (
        <Spinner size="sm" shade="subtle" label={copy.loading} className="maka-task-ledger-message" />
      ) : props.items.length === 0 ? (
        <EmptyState
          isCompact
          className="maka-task-ledger-empty"
          icon={<ListTodo size={ICON_SIZE.empty} aria-hidden="true" />}
          title={copy.empty}
        />
      ) : (
        <ol className="maka-task-ledger-tree" aria-label={copy.activeAriaLabel}>
          {props.items.map((item, index) => {
            const StatusIcon = STATUS_ICONS[item.status];
            return (
              <li className="maka-task-ledger-row" key={`${index}:${item.status}:${item.content}`}>
                <StatusIcon size={ICON_SIZE.control} aria-hidden="true" />
                <span>{item.content}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
