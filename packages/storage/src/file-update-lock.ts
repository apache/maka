import { mkdir, rm } from 'node:fs/promises';

const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

export async function withFileUpdateLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `File update is locked by another process (${lockPath}). ` +
            'If no other process is using it, remove that directory and retry.',
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
