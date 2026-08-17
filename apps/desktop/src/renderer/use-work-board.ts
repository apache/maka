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
}

export interface UseWorkBoardResult extends WorkBoardSnapshot {
  retry(): void;
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
          setSnapshot(
            result.ok
              ? {
                  items: result.value.items,
                  nextCursor: result.value.nextCursor,
                  loading: false,
                }
              : { items: [], loading: false, error: result.message },
          );
        },
        (error: unknown) => {
          if (revision !== revisionRef.current) return;
          setSnapshot((current) => ({
            items: current.items,
            loading: false,
            error: error instanceof Error ? error.message : 'Work Board load failed',
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

  const loadMore = useCallback(() => {
    const cursor = snapshot.nextCursor;
    if (!cursor || snapshot.loading) return;
    const revision = ++revisionRef.current;
    setSnapshot((current) => ({ ...current, loading: true }));
    void window.maka.workBoard.list({ ...query, cursor }).then(
      (result) => {
        if (revision !== revisionRef.current) return;
        if (!result.ok) {
          setSnapshot((current) => ({ ...current, loading: false, error: result.message }));
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
          };
        });
      },
      (error: unknown) => {
        if (revision !== revisionRef.current) return;
        setSnapshot((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : 'Work Board load failed',
        }));
      },
    );
  }, [query, snapshot.loading, snapshot.nextCursor]);

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
