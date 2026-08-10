import { mkdir } from 'node:fs/promises';
import { runHostedExecution } from '@maka/runtime-host/client';
import type { HostedExecutionStartInput } from '@maka/runtime-host/protocol';

const payload = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString()) as {
  rootPath: string;
  baseUrl: string;
  execution: HostedExecutionStartInput;
};
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
await mkdir(payload.rootPath, { recursive: true });
const result = await runHostedExecution({
  rootPath: payload.rootPath,
  baseUrl: payload.baseUrl,
  execution: payload.execution,
  signal: abort.signal,
});
process.stdout.write(JSON.stringify(result));
if (result.kind === 'indeterminate') process.exitCode = 1;
