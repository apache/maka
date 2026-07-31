import type { TaskLedgerStore } from '@maka/core';
import {
  createSqliteTaskLedgerStore,
  type SqliteTaskLedgerStore,
} from '@maka/storage';
import { buildTaskLedgerTools, isTaskLedgerToolsEnabled, type MakaTool } from '@maka/runtime';

/**
 * The task-ledger wiring the main process needs: one per-session store shared
 * by the mutate face (task_create/task_update tools) and the read face (the
 * turn-tail fragment). Grouping the construction here keeps the main-process
 * entry a thin assembler and lets the contract assert the wiring at behavior
 * level (tools present, store real, a create lands in the store the tail
 * reads) instead of via source-text regex.
 */
export interface MainTaskLedgerWiring {
  /** Per-session task ledger store; shared by tools (mutate) and turn tail (read). */
  store: TaskLedgerStore & SqliteTaskLedgerStore;
  /** task_create/task_update/task_list/task_get bound to {@link store}. */
  tools: MakaTool[];
}

export function createMainTaskLedgerWiring(workspaceRoot: string): MainTaskLedgerWiring {
  const store = createSqliteTaskLedgerStore(workspaceRoot);
  return {
    store,
    tools: isTaskLedgerToolsEnabled()
      ? buildTaskLedgerTools({ store }, { includeLegacyAliases: isTaskLedgerLegacyToolsEnabled() })
      : [],
  };
}

function isTaskLedgerLegacyToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on)$/i.test((env.MAKA_TASK_LEDGER_LEGACY_TOOLS ?? '').trim());
}
