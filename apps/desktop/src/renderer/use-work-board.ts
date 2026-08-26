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

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  WORK_BOARD_PAGE_SIZE_MAX,
  type CreateWorkBoardItemInput,
  type UpdateWorkBoardItemInput,
  type WorkBoardItem,
  type WorkBoardListQuery,
  type WorkBoardPage,
} from '@maka/core/work-board';
import type { WorkBoardMutationOptions } from '@maka/storage/work-board-store';
import type { WorkBoardChangedEvent, WorkBoardIpcResult } from '../shared/work-board-ipc.js';

interface WorkBoardSnapshot {
  items: WorkBoardItem[];
  nextCursor?: string;
  loading: boolean;
  error?: string;
  continuationError?: string;
  continuationCursor?: string;
}

export interface UseWorkBoardResult extends WorkBoardSnapshot {
  retry(): void;
  retryContinuation(): void;
  loadMore(): void;
  create(input: CreateWorkBoardItemInput): Promise<WorkBoardItem>;
  update(
    id: string,
    patch: UpdateWorkBoardItemInput,
    options?: WorkBoardMutationOptions,
  ): Promise<WorkBoardItem>;
  archive(id: string, options?: WorkBoardMutationOptions): Promise<WorkBoardItem>;
  unarchive(id: string, options?: WorkBoardMutationOptions): Promise<WorkBoardItem>;
  remove(id: string, options?: WorkBoardMutationOptions): Promise<void>;
}

const EMPTY_SNAPSHOT: WorkBoardSnapshot = {
  items: [],
  nextCursor: undefined,
  loading: false,
  continuationError: undefined,
  continuationCursor: undefined,
};

type WorkBoardList = (
  query?: WorkBoardListQuery,
) => Promise<WorkBoardIpcResult<WorkBoardPage>>;

async function listWindow(
  list: WorkBoardList,
  query: WorkBoardListQuery | undefined,
  targetCount: number,
): Promise<WorkBoardIpcResult<WorkBoardPage>> {
  const first = await list(
    targetCount > 0
      ? { ...query, limit: Math.min(WORK_BOARD_PAGE_SIZE_MAX, targetCount) }
      : query,
  );
  if (!first.ok || targetCount <= first.value.items.length || !first.value.nextCursor) {
    return first;
  }

  const items = [...first.value.items];
  let nextCursor: string | undefined = first.value.nextCursor;
  while (items.length < targetCount && nextCursor) {
    const page = await list({ ...query, limit: WORK_BOARD_PAGE_SIZE_MAX, cursor: nextCursor });
    if (!page.ok) return page;
    const known = new Set(items.map((item) => item.id));
    items.push(...page.value.items.filter((item) => !known.has(item.id)));
    nextCursor = page.value.nextCursor;
    if (page.value.items.length === 0) break;
  }
  return { ok: true, value: { items, nextCursor } };
}

function requireResult<T>(result: WorkBoardIpcResult<T>): T {
  if (result.ok) return result.value;
  throw new Error(result.message);
}

/**
 * Read-only renderer projection of the Work Board store. All mutations are
 * routed through the Desktop main process; the change signal triggers a reload
 * so the panel never caches a second execution authority.
 */
export function useWorkBoard(query?: WorkBoardListQuery): UseWorkBoardResult {
  const revisionRef = useRef(0);
  const loadedItemCountRef = useRef(0);
  const [snapshot, setSnapshot] = useState<WorkBoardSnapshot>(EMPTY_SNAPSHOT);

  const load = useCallback(
    (preserveItems: boolean) => {
      const revision = ++revisionRef.current;
      const loadedItemCount = preserveItems ? loadedItemCountRef.current : 0;
      setSnapshot((current) => {
        if (!preserveItems) loadedItemCountRef.current = 0;
        return {
          items: preserveItems ? current.items : [],
          nextCursor: preserveItems ? current.nextCursor : undefined,
          loading: true,
        };
      });
      void listWindow(window.maka.workBoard.list, query, loadedItemCount).then(
        (result) => {
          if (revision !== revisionRef.current) return;
          if (result.ok) {
            loadedItemCountRef.current = result.value.items.length;
            setSnapshot({
              items: result.value.items,
              nextCursor: result.value.nextCursor,
              loading: false,
              continuationError: undefined,
              continuationCursor: undefined,
            });
            return;
          }
          setSnapshot((current) => ({
            items: current.items,
            nextCursor: current.nextCursor,
            loading: false,
            error: current.items.length === 0 ? result.message : undefined,
            continuationError: current.items.length > 0 ? result.message : undefined,
            continuationCursor: undefined,
          }));
        },
        (error: unknown) => {
          if (revision !== revisionRef.current) return;
          const message = error instanceof Error ? error.message : 'Work Board load failed';
          setSnapshot((current) => ({
            items: current.items,
            nextCursor: current.nextCursor,
            loading: false,
            error: current.items.length === 0 ? message : undefined,
            continuationError: current.items.length > 0 ? message : undefined,
            continuationCursor: undefined,
          }));
        },
      );
      },
    [query],
  );

  useEffect(() => {
    revisionRef.current += 1;
    const unsubscribe = window.maka.workBoard.subscribeChanges(
      (_event: WorkBoardChangedEvent) => load(true),
    );
    load(false);
    return () => {
      revisionRef.current += 1;
      unsubscribe();
    };
  }, [load]);

  const retry = useCallback(() => load(true), [load]);

  const loadMoreAt = useCallback((cursor: string) => {
    const revision = ++revisionRef.current;
    setSnapshot((current) => ({
      ...current,
      loading: true,
      continuationError: undefined,
      continuationCursor: undefined,
    }));
    void window.maka.workBoard.list({ ...query, cursor }).then(
      (result) => {
        if (revision !== revisionRef.current) return;
        if (!result.ok) {
          setSnapshot((current) => ({
            ...current,
            loading: false,
            continuationError: result.message,
            continuationCursor: cursor,
          }));
          return;
        }
        setSnapshot((current) => {
          const known = new Set(current.items.map((item: WorkBoardItem) => item.id));
          const appended = result.value.items.filter(
            (item: WorkBoardItem) => !known.has(item.id),
          );
          const items = [...current.items, ...appended];
          loadedItemCountRef.current = items.length;
          return {
            items,
            nextCursor: result.value.nextCursor,
            loading: false,
            continuationError: undefined,
            continuationCursor: undefined,
          };
        });
      },
      (error: unknown) => {
        if (revision !== revisionRef.current) return;
        const message = error instanceof Error ? error.message : 'Work Board load failed';
        setSnapshot((current) => ({
          ...current,
          loading: false,
          continuationError: message,
          continuationCursor: cursor,
        }));
      },
    );
  }, [query]);

  const loadMore = useCallback(() => {
    if (!snapshot.nextCursor || snapshot.loading) return;
    loadMoreAt(snapshot.nextCursor);
  }, [loadMoreAt, snapshot.loading, snapshot.nextCursor]);

  const retryContinuation = useCallback(() => {
    if (snapshot.continuationCursor) loadMoreAt(snapshot.continuationCursor);
    else load(true);
  }, [load, loadMoreAt, snapshot.continuationCursor]);

  // The main process emits workBoard:changed for every successful mutation;
  // the subscription above is the single reload path, so no second list
  // request is issued here.
  const mutate = useCallback(
    async <T>(operation: () => Promise<WorkBoardIpcResult<T>>): Promise<T> =>
      requireResult(await operation()),
    [],
  );

  return {
    ...snapshot,
    retry,
    retryContinuation,
    loadMore,
    create: (input) => mutate(() => window.maka.workBoard.create(input)),
    update: (id, patch, options) =>
      mutate(() => window.maka.workBoard.update(id, patch, options)),
    archive: (id, options) => mutate(() => window.maka.workBoard.archive(id, options)),
    unarchive: (id, options) => mutate(() => window.maka.workBoard.unarchive(id, options)),
    remove: async (id, options) => {
      await mutate(() => window.maka.workBoard.remove(id, options));
    },
  };
}
