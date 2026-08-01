import {
  createSqliteAgentRunStore,
  createSqliteShellRunStore,
} from '@maka/storage';

export interface DesktopExecutionStoreWiring {
  readonly runStore: ReturnType<typeof createSqliteAgentRunStore>;
  readonly shellRunStore: ReturnType<typeof createSqliteShellRunStore>;
  close(): void;
}

/**
 * Open the two core execution stores only after their legacy cutovers finish.
 * Keeping this boundary explicit prevents Desktop services from observing a
 * partially imported root and gives shutdown one owner for both database
 * leases.
 */
export async function openDesktopExecutionStoreWiring(
  workspaceRoot: string,
): Promise<DesktopExecutionStoreWiring> {
  const runStore = createSqliteAgentRunStore(workspaceRoot);
  let shellRunStore: ReturnType<typeof createSqliteShellRunStore> | undefined;
  try {
    shellRunStore = createSqliteShellRunStore(workspaceRoot);
    await Promise.all([runStore.ready?.(), shellRunStore.ready()]);
  } catch (error) {
    shellRunStore?.close();
    runStore.close?.();
    throw error;
  }

  let closed = false;
  return Object.freeze({
    runStore,
    shellRunStore,
    close: () => {
      if (closed) return;
      closed = true;
      shellRunStore.close();
      runStore.close?.();
    },
  });
}
