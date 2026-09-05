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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Banner, EmptyState, Spinner } from '@astryxdesign/core';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useUiLocale } from '@maka/ui';
import type {
  CreateWorkBoardItemInput,
  WorkBoardItem,
  WorkBoardListQuery,
  WorkBoardScope,
} from '@maka/core/work-board';
import { ListTodo } from '@maka/ui/icons';
import { useWorkBoard } from './use-work-board.js';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

type WorkBoardPanelCopy = ReturnType<typeof getDesktopConversationCopy>['workBoardPanel'];

function scopeForFilter(filter: 'inbox' | 'project', projectId: string | null): WorkBoardScope {
  return filter === 'project' && projectId !== null
    ? { kind: 'project', projectId }
    : { kind: 'inbox' };
}

interface ActiveWorkBoardRowActions {
  kind: 'active';
  projectId: string | null;
  renaming: boolean;
  renameValue: string;
  onRenameStart(): void;
  onRenameChange(value: string): void;
  onRenameSave(): void;
  onRenameCancel(): void;
  onComplete(): void;
  onReopen(): void;
  onMove(): void;
  onArchive(): void;
}

interface ArchivedWorkBoardRowActions {
  kind: 'archived';
  onUnarchive(): void;
  onRemove(): void;
}

function WorkBoardRow(props: {
  item: WorkBoardItem;
  copy: WorkBoardPanelCopy;
  actions: ActiveWorkBoardRowActions | ArchivedWorkBoardRowActions;
}) {
  const { item, copy, actions } = props;
  return (
    <li className="maka-work-board-row" data-archived={item.archived || undefined}>
      <div className="maka-work-board-row-main">
        {actions.kind === 'active' && actions.renaming ? (
          <TextInput
            className="maka-work-board-rename-input"
            size="sm"
            label={copy.rename}
            isLabelHidden
            hasAutoFocus
            value={actions.renameValue}
            onChange={actions.onRenameChange}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing || event.key === 'Process') return;
              if (event.key === 'Enter') {
                event.preventDefault();
                actions.onRenameSave();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                actions.onRenameCancel();
              }
            }}
          />
        ) : (
          <span className="maka-work-board-title">{item.title}</span>
        )}
        {item.archived && <span className="maka-work-board-archived-tag">{copy.archived}</span>}
      </div>
      <div className="maka-work-board-row-actions">
        {actions.kind === 'archived' ? (
          <>
            <Button size="sm" variant="ghost" label={copy.unarchive} onClick={actions.onUnarchive} />
            <Button size="sm" variant="ghost" label={copy.delete} onClick={actions.onRemove} />
          </>
        ) : (
          <>
            {item.state === 'done' ? (
              <Button size="sm" variant="ghost" label={copy.reopen} onClick={actions.onReopen} />
            ) : (
              <Button size="sm" variant="ghost" label={copy.complete} onClick={actions.onComplete} />
            )}
            {actions.renaming ? (
              <Button
                size="sm"
                variant="primary"
                label={copy.renameSave}
                onClick={actions.onRenameSave}
              />
            ) : (
              <Button size="sm" variant="ghost" label={copy.rename} onClick={actions.onRenameStart} />
            )}
            <Button
              size="sm"
              variant="ghost"
              label={item.scope.kind === 'project' ? copy.moveToInbox : copy.moveToProject}
              onClick={actions.onMove}
              isDisabled={actions.projectId === null}
            />
            <Button size="sm" variant="ghost" label={copy.archive} onClick={actions.onArchive} />
          </>
        )}
      </div>
    </li>
  );
}

export function WorkBoardPanel(props: {
  projectId: string | null;
  projectAliases?: readonly string[];
}) {
  const copy = getDesktopConversationCopy(useUiLocale()).workBoardPanel;
  const [filter, setFilter] = useState<'inbox' | 'project'>('inbox');
  const projectScopeIds = useMemo(() => {
    if (props.projectId === null) return undefined;
    return [...new Set([props.projectId, ...(props.projectAliases ?? [])])];
  }, [props.projectAliases, props.projectId]);
  const query: WorkBoardListQuery = useMemo(
    () => ({
      scope: scopeForFilter(filter, props.projectId),
      includeArchived: true,
      ...(filter === 'project' && projectScopeIds ? { projectIds: projectScopeIds } : {}),
    }),
    [filter, projectScopeIds, props.projectId],
  );
  const board = useWorkBoard(query);
  const [newTitle, setNewTitle] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState('');
  const [renamingRevision, setRenamingRevision] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | undefined>();
  const createPendingRef = useRef(false);
  const [createPending, setCreatePending] = useState(false);

  useEffect(() => {
    if (props.projectId === null) setFilter('inbox');
  }, [props.projectId]);

  const activeItems = board.items.filter((item) => !item.archived);
  const archivedItems = board.items.filter((item) => item.archived);

  const runAction = async (action: () => Promise<unknown>): Promise<boolean> => {
    setActionError(undefined);
    try {
      await action();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : copy.actionFailed);
      return false;
    }
  };

  const create = async (): Promise<void> => {
    const title = newTitle.trim();
    if (!title || createPendingRef.current) return;
    createPendingRef.current = true;
    setCreatePending(true);
    const input: CreateWorkBoardItemInput = {
      scope: query.scope ?? { kind: 'inbox' },
      title,
      creator: { kind: 'user' },
      provenance: { kind: 'manual' },
    };
    try {
      if (await runAction(() => board.create(input))) {
        setNewTitle('');
      }
    } finally {
      createPendingRef.current = false;
      setCreatePending(false);
    }
  };

  const startRename = (item: WorkBoardItem): void => {
    setRenamingId(item.id);
    setRenamingTitle(item.title);
    setRenamingRevision(item.revision);
  };

  const saveRename = async (item: WorkBoardItem): Promise<void> => {
    const title = renamingTitle.trim();
    if (!title) return;
    if (
      await runAction(() =>
        board.update(item.id, { title }, { expectedRevision: renamingRevision ?? item.revision }),
      )
    ) {
      setRenamingId(null);
      setRenamingRevision(null);
    }
  };

  const moveScope = (item: WorkBoardItem): WorkBoardScope =>
    item.scope.kind === 'project'
      ? { kind: 'inbox' }
      : props.projectId !== null
        ? { kind: 'project', projectId: props.projectId }
        : item.scope;

  return (
    <section
      className="maka-work-board-panel"
      aria-label={filter === 'project' ? copy.project : copy.inbox}
    >
      {actionError && (
        <Banner status="error" role="alert" className="maka-work-board-message" title={actionError} />
      )}
      <div className="maka-work-board-filters">
        <Button
          size="sm"
          variant={filter === 'inbox' ? 'primary' : 'ghost'}
          label={copy.inbox}
          onClick={() => setFilter('inbox')}
        />
        <Button
          size="sm"
          variant={filter === 'project' ? 'primary' : 'ghost'}
          label={copy.project}
          onClick={() => setFilter('project')}
          isDisabled={props.projectId === null}
          tooltip={props.projectId === null ? copy.noProject : undefined}
        />
      </div>
      <div className="maka-work-board-create">
        <TextInput
          className="maka-work-board-create-input"
          size="sm"
          label={copy.createPlaceholder}
          isLabelHidden
          value={newTitle}
          onChange={setNewTitle}
          isDisabled={createPending}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing || event.key === 'Process') return;
            if (event.key === 'Enter') {
              event.preventDefault();
              void create();
            }
          }}
          placeholder={copy.createPlaceholder}
        />
        <Button
          size="sm"
          label={copy.create}
          onClick={() => void create()}
          isDisabled={createPending || newTitle.trim().length === 0}
        />
      </div>
      {board.error && board.items.length === 0 ? (
        <Banner
          status="error"
          role="alert"
          className="maka-work-board-message"
          title={copy.loadFailed}
          description={board.error}
          endContent={
            <Button size="sm" variant="ghost" label={copy.retry} onClick={board.retry} />
          }
        />
      ) : (
        <>
          {board.continuationError && (
            <Banner
              status="error"
              role="alert"
              className="maka-work-board-message"
              title={copy.loadFailed}
              description={board.continuationError}
              endContent={
                <Button
                  size="sm"
                  variant="ghost"
                  label={copy.retry}
                  onClick={board.retryContinuation}
                />
              }
            />
          )}
          {board.loading && board.items.length === 0 ? (
            <Spinner size="sm" shade="subtle" label={copy.loading} className="maka-work-board-message" />
          ) : (
            <>
              {activeItems.length === 0 && archivedItems.length === 0 ? (
                <EmptyState
                  isCompact
                  className="maka-work-board-empty"
                  icon={<ListTodo size={24} aria-hidden="true" />}
                  title={copy.empty}
                />
              ) : (
                <ul className="maka-work-board-list">
              {activeItems.map((item) => (
                <WorkBoardRow
                  key={item.id}
                  item={item}
                  copy={copy}
                  actions={{
                    kind: 'active',
                    projectId: props.projectId,
                    renaming: renamingId === item.id,
                    renameValue: renamingTitle,
                    onRenameStart: () => startRename(item),
                    onRenameChange: setRenamingTitle,
                    onRenameSave: () => void saveRename(item),
                    onRenameCancel: () => {
                      setRenamingId(null);
                      setRenamingRevision(null);
                    },
                    onComplete: () =>
                      void runAction(() =>
                        board.update(item.id, { state: 'done' }, { expectedRevision: item.revision }),
                      ),
                    onReopen: () =>
                      void runAction(() =>
                        board.update(item.id, { state: 'todo' }, { expectedRevision: item.revision }),
                      ),
                    onMove: () =>
                      void runAction(() =>
                        board.update(item.id, { scope: moveScope(item) }, { expectedRevision: item.revision }),
                      ),
                    onArchive: () =>
                      void runAction(() => board.archive(item.id, { expectedRevision: item.revision })),
                  }}
                />
              ))}
              {archivedItems.map((item) => (
                <WorkBoardRow
                  key={item.id}
                  item={item}
                  copy={copy}
                  actions={{
                    kind: 'archived',
                    onUnarchive: () =>
                      void runAction(() =>
                        board.unarchive(item.id, { expectedRevision: item.revision }),
                      ),
                    onRemove: () =>
                      void runAction(() => board.remove(item.id, { expectedRevision: item.revision })),
                  }}
                />
              ))}
                </ul>
              )}
              {board.nextCursor && (
                <Button
                  size="sm"
                  variant="ghost"
                  label={copy.loadMore}
                  onClick={board.loadMore}
                  isDisabled={board.loading}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
