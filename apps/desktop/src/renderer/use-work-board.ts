import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CreateWorkBoardItemInput,
  UpdateWorkBoardItemInput,
  WorkBoardItem,
  WorkBoardListQuery,
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
  const [snapshot, setSnapshot] = useState<WorkBoardSnapshot>(EMPTY_SNAPSHOT);

  const load = useCallback(
    (preserveItems: boolean) => {
      const revision = ++revisionRef.current;
      setSnapshot((current) => ({
        items: preserveItems ? current.items : [],
        nextCursor: preserveItems ? current.nextCursor : undefined,
        loading: true,
      }));
      void window.maka.workBoard.list(query).then(
        (result) => {
          if (revision !== revisionRef.current) return;
          if (result.ok) {
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
          return {
            items: [...current.items, ...appended],
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
