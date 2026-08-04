import {
  RuntimeHostProcessTerminationRequiredError,
  type RuntimeHostKernel,
} from './host-kernel.js';

export interface RuntimeHostProcessLifecycleOptions {
  closeOnDisconnect?: boolean;
  onReady?: () => void;
}

export async function runRuntimeHostProcessLifecycle(
  host: Pick<RuntimeHostKernel, 'close' | 'closed'>,
  options: RuntimeHostProcessLifecycleOptions = {},
): Promise<void> {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void host.close();
  };

  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  if (options.closeOnDisconnect) process.once('disconnect', close);
  try {
    options.onReady?.();
    await host.closed;
  } catch (error) {
    if (error instanceof RuntimeHostProcessTerminationRequiredError) process.exit(1);
    throw error;
  } finally {
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
    if (options.closeOnDisconnect) process.off('disconnect', close);
  }
}
