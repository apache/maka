import { ipcMain } from 'electron';
import type { ScheduledTask } from '@maka/core';
import type {
  ScheduledTaskMutateInput,
  ScheduledTaskMutateResult,
} from '@maka/runtime-host/protocol';

interface ScheduledTaskIpcDeps {
  client: {
    listScheduledTasks(): Promise<ScheduledTask[]>;
    mutateScheduledTask(input: ScheduledTaskMutateInput): Promise<ScheduledTaskMutateResult>;
  };
  ipcMain?: Pick<typeof ipcMain, 'handle'>;
}

export function registerScheduledTaskIpc(deps: ScheduledTaskIpcDeps): void {
  const target = deps.ipcMain ?? ipcMain;
  target.handle('scheduled-tasks:list', () => deps.client.listScheduledTasks());
  target.handle('scheduled-tasks:create', (_event, input: unknown) =>
    taskResult(deps.client.mutateScheduledTask({ kind: 'create', input: input as never })),
  );
  target.handle('scheduled-tasks:update', async (_event, id: string, patch: unknown) => {
    return taskResult(
      deps.client.mutateScheduledTask({ kind: 'update', taskId: id, patch: patch as never }),
    );
  });
  target.handle('scheduled-tasks:setEnabled', async (_event, id: string, enabled: boolean) =>
    taskResult(
      deps.client.mutateScheduledTask({ kind: enabled ? 'resume' : 'pause', taskId: id }),
    ),
  );
  target.handle('scheduled-tasks:delete', (_event, id: string) =>
    deps.client.mutateScheduledTask({ kind: 'delete', taskId: id }).then(() => undefined),
  );
  target.handle('scheduled-tasks:triggerNow', (_event, id: string) =>
    taskResult(deps.client.mutateScheduledTask({ kind: 'trigger_now', taskId: id })),
  );
  target.handle('scheduled-tasks:snooze', (_event, id: string) =>
    taskResult(
      deps.client.mutateScheduledTask({ kind: 'snooze', taskId: id, delayMs: 10 * 60 * 1000 }),
    ),
  );
  target.handle('scheduled-tasks:clearRunHistory', (_event, id: string) =>
    taskResult(deps.client.mutateScheduledTask({ kind: 'clear_history', taskId: id })),
  );
}

async function taskResult(result: Promise<ScheduledTaskMutateResult>): Promise<ScheduledTask> {
  const value = await result;
  if (value.kind !== 'task') throw new Error('Runtime Host returned no ScheduledTask');
  return value.task;
}
