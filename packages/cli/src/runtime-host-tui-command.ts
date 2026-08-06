import { runMakaPiTui } from './pi-tui-runner.js';
import { createRuntimeHostTuiContext } from './runtime-host-tui-context.js';

export interface RunRuntimeHostTuiInput {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly onProcessExit: (exitCode: number, error?: Error) => void;
}

export async function runRuntimeHostTui(input: RunRuntimeHostTuiInput): Promise<number> {
  const context = await createRuntimeHostTuiContext({
    rootPath: input.workspaceRoot,
    cwd: input.cwd,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
  });
  try {
    await runMakaPiTui({
      driver: context.driver,
      title: 'Maka',
      cwd: context.cwd,
      model: context.model,
      models: context.modelChoices
        .filter((choice) => choice.connectionSlug === context.connectionSlug)
        .map((choice) => choice.model),
      modelChoices: context.modelChoices,
      connectionSlug: context.connectionSlug,
      providerType: context.providerType,
      modelContextWindow: context.modelContextWindow,
      permissionMode: 'ask',
      goalLifecycle: context.goalLifecycle,
      listSkills: context.listSkills,
      recap: context.recap,
      subscribeShellRunUpdates: (listener) => context.driver.subscribeShellRunUpdates(listener),
      listShellRunUpdates: (sessionId) => context.driver.listShellRunUpdates(sessionId),
      onProcessExit: input.onProcessExit,
      resumeSessionId: input.resumeSessionId,
    });
    const sessionId = context.driver.getSessionId();
    if (sessionId)
      process.stdout.write(`Resume this session with:\n  maka --resume ${sessionId}\n`);
    return 0;
  } finally {
    await context.close();
  }
}
