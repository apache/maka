import { useMemo, useState } from 'react';
import { Banner, EmptyState, Spinner } from '@astryxdesign/core';
import { Button } from '@astryxdesign/core/Button';
import type { UiLocale } from '@maka/core/ui-locale';
import { useUiLocale } from '@maka/ui';
import type {
  CreateWorkBoardItemInput,
  WorkBoardItem,
  WorkBoardListQuery,
  WorkBoardScope,
} from '@maka/core/work-board';
import { ListTodo } from '@maka/ui/icons';
import { useWorkBoard } from './use-work-board.js';

interface WorkBoardPanelCopy {
  inbox: string;
  project: string;
  noProject: string;
  createPlaceholder: string;
  create: string;
  empty: string;
  loading: string;
  retry: string;
  loadFailed: string;
  actionFailed: string;
  complete: string;
  reopen: string;
  rename: string;
  renameSave: string;
  moveToInbox: string;
  moveToProject: string;
  archive: string;
  unarchive: string;
  delete: string;
  archived: string;
}

function getWorkBoardPanelCopy(locale: UiLocale): WorkBoardPanelCopy {
  return locale === 'zh'
    ? {
        inbox: 'Inbox',
        project: '当前项目',
        noProject: '未选择项目',
        createPlaceholder: '记录稍后处理的事项…',
        create: '添加',
        empty: '暂无暂缓事项',
        loading: '正在加载工作看板…',
        retry: '重试',
        loadFailed: '工作看板加载失败',
        actionFailed: '操作失败',
        complete: '完成',
        reopen: '重开',
        rename: '改名',
        renameSave: '保存',
        moveToInbox: '移到 Inbox',
        moveToProject: '移到项目',
        archive: '归档',
        unarchive: '恢复',
        delete: '删除',
        archived: '已归档',
      }
    : {
        inbox: 'Inbox',
        project: 'Current project',
        noProject: 'No project selected',
        createPlaceholder: 'Capture something for later…',
        create: 'Add',
        empty: 'No deferred work',
        loading: 'Loading work board…',
        retry: 'Retry',
        loadFailed: 'Failed to load work board',
        actionFailed: 'Action failed',
        complete: 'Complete',
        reopen: 'Reopen',
        rename: 'Rename',
        renameSave: 'Save',
        moveToInbox: 'Move to Inbox',
        moveToProject: 'Move to project',
        archive: 'Archive',
        unarchive: 'Restore',
        delete: 'Delete',
        archived: 'Archived',
      };
}

function scopeForFilter(filter: 'inbox' | 'project', projectId: string | null): WorkBoardScope {
  return filter === 'project' && projectId !== null
    ? { kind: 'project', projectId }
    : { kind: 'inbox' };
}

function WorkBoardRow(props: {
  item: WorkBoardItem;
  copy: WorkBoardPanelCopy;
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
  onUnarchive(): void;
  onRemove(): void;
}) {
  const { item, copy } = props;
  return (
    <li className="maka-work-board-row" data-archived={item.archived || undefined}>
      <div className="maka-work-board-row-main">
        {props.renaming ? (
          <input
            className="maka-work-board-rename-input"
            value={props.renameValue}
            onChange={(event) => props.onRenameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') props.onRenameSave();
              if (event.key === 'Escape') props.onRenameCancel();
            }}
            aria-label={copy.rename}
          />
        ) : (
          <span className="maka-work-board-title">{item.title}</span>
        )}
        {item.archived && <span className="maka-work-board-archived-tag">{copy.archived}</span>}
      </div>
      <div className="maka-work-board-row-actions">
        {item.archived ? (
          <>
            <Button size="sm" variant="ghost" label={copy.unarchive} onClick={props.onUnarchive} />
            <Button size="sm" variant="ghost" label={copy.delete} onClick={props.onRemove} />
          </>
        ) : (
          <>
            {item.state === 'done' ? (
              <Button size="sm" variant="ghost" label={copy.reopen} onClick={props.onReopen} />
            ) : (
              <Button size="sm" variant="ghost" label={copy.complete} onClick={props.onComplete} />
            )}
            {props.renaming ? (
              <Button
                size="sm"
                variant="primary"
                label={copy.renameSave}
                onClick={props.onRenameSave}
              />
            ) : (
              <Button size="sm" variant="ghost" label={copy.rename} onClick={props.onRenameStart} />
            )}
            <Button
              size="sm"
              variant="ghost"
              label={item.scope.kind === 'project' ? copy.moveToInbox : copy.moveToProject}
              onClick={props.onMove}
              isDisabled={props.projectId === null}
            />
            <Button size="sm" variant="ghost" label={copy.archive} onClick={props.onArchive} />
          </>
        )}
      </div>
    </li>
  );
}

export function WorkBoardPanel(props: { projectId: string | null }) {
  const locale = useUiLocale();
  const copy = getWorkBoardPanelCopy(locale);
  const [filter, setFilter] = useState<'inbox' | 'project'>('inbox');
  const query: WorkBoardListQuery = useMemo(
    () => ({
      scope: scopeForFilter(filter, props.projectId),
      includeArchived: true,
    }),
    [filter, props.projectId],
  );
  const board = useWorkBoard(query);
  const [newTitle, setNewTitle] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState('');
  const [actionError, setActionError] = useState<string | undefined>();

  const activeItems = board.items.filter((item) => !item.archived);
  const archivedItems = board.items.filter((item) => item.archived);

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    setActionError(undefined);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : copy.actionFailed);
    }
  };

  const create = async (): Promise<void> => {
    const title = newTitle.trim();
    if (!title) return;
    const input: CreateWorkBoardItemInput = {
      scope: query.scope ?? { kind: 'inbox' },
      title,
      creator: { kind: 'user' },
      provenance: { kind: 'manual' },
    };
    await runAction(() => board.create(input));
    setNewTitle('');
  };

  const startRename = (item: WorkBoardItem): void => {
    setRenamingId(item.id);
    setRenamingTitle(item.title);
  };

  const saveRename = async (item: WorkBoardItem): Promise<void> => {
    const title = renamingTitle.trim();
    if (!title) return;
    await runAction(() => board.update(item.id, { title }));
    setRenamingId(null);
  };

  const moveScope = (item: WorkBoardItem): WorkBoardScope =>
    item.scope.kind === 'project'
      ? { kind: 'inbox' }
      : props.projectId !== null
        ? { kind: 'project', projectId: props.projectId }
        : item.scope;

  return (
    <section className="maka-work-board-panel" aria-label={copy.inbox}>
      {actionError && (
        <Banner status="error" role="alert" className="maka-work-board-message" title={actionError} />
      )}
      <div className="maka-work-board-filters" role="tablist" aria-label={copy.inbox}>
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
        <input
          className="maka-work-board-create-input"
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create();
          }}
          placeholder={copy.createPlaceholder}
          aria-label={copy.createPlaceholder}
        />
        <Button
          size="sm"
          label={copy.create}
          onClick={() => void create()}
          isDisabled={newTitle.trim().length === 0}
        />
      </div>
      {board.error ? (
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
      ) : board.loading && board.items.length === 0 ? (
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
                  projectId={props.projectId}
                  renaming={renamingId === item.id}
                  renameValue={renamingTitle}
                  onRenameStart={() => startRename(item)}
                  onRenameChange={setRenamingTitle}
                  onRenameSave={() => void saveRename(item)}
                  onRenameCancel={() => setRenamingId(null)}
                  onComplete={() =>
                    void runAction(() => board.update(item.id, { state: 'done' }))
                  }
                  onReopen={() =>
                    void runAction(() => board.update(item.id, { state: 'todo' }))
                  }
                  onMove={() => void runAction(() => board.update(item.id, { scope: moveScope(item) }))}
                  onArchive={() => void runAction(() => board.archive(item.id))}
                  onUnarchive={() => void runAction(() => board.unarchive(item.id))}
                  onRemove={() => void runAction(() => board.remove(item.id))}
                />
              ))}
              {archivedItems.map((item) => (
                <WorkBoardRow
                  key={item.id}
                  item={item}
                  copy={copy}
                  projectId={props.projectId}
                  renaming={false}
                  renameValue=""
                  onRenameStart={() => undefined}
                  onRenameChange={() => undefined}
                  onRenameSave={() => undefined}
                  onRenameCancel={() => undefined}
                  onComplete={() => undefined}
                  onReopen={() => undefined}
                  onMove={() => undefined}
                  onArchive={() => undefined}
                  onUnarchive={() => void runAction(() => board.unarchive(item.id))}
                  onRemove={() => void runAction(() => board.remove(item.id))}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
