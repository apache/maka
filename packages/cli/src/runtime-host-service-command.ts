import {
  installRuntimeHostLogCapture,
  runRuntimeHostProcessLifecycle,
  startExecutionRuntimeHostService,
} from '@maka/runtime-host/server';

export async function runRuntimeHostServiceCli(rootPath: string): Promise<number> {
  installRuntimeHostLogCapture();
  const host = await startExecutionRuntimeHostService({ rootPath });
  await runRuntimeHostProcessLifecycle(host, {
    onReady: () => process.stdout.write(`Runtime Host service is ready at ${host.endpoint}\n`),
  });
  return 0;
}
