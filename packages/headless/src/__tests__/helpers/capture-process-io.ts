/**
 * Capture process.stdout/stderr writes around an in-process CLI invocation.
 *
 * Tests that used to spawn a Node subprocess to observe a command's output can
 * run the command in process and read the same two channels here. Only safe
 * for sequential tests: the capture swaps the process-wide stream writers.
 */
export async function withCapturedProcessIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const savedStdoutWrite = process.stdout.write;
  const savedStderrWrite = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = savedStdoutWrite;
    process.stderr.write = savedStderrWrite;
  }
}
