import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runHostedExecution } from '@maka/runtime-host/client';
import type { HostedExecutionStartInput } from '@maka/runtime-host/protocol';
import { disabledWebToolsRuntimePolicyDocument } from './maka-runtime-policy.js';
import { takeRelayResultToken, writeRelayResult } from './relay-result-frame.js';

const resultToken = takeRelayResultToken();

const payload = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString()) as {
  rootPath: string;
  baseUrl: string;
  webTools: 'enabled' | 'disabled';
  hostSettlementTimeoutMs: number;
  execution: HostedExecutionStartInput;
};
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const runtimeHome = join(dirname(payload.rootPath), `${process.pid}-home`);
await mkdir(payload.rootPath, { recursive: true });
await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
if (payload.webTools === 'disabled') {
  await writeFile(
    join(payload.rootPath, 'runtime-policy.json'),
    `${JSON.stringify(disabledWebToolsRuntimePolicyDocument(process.env.HTTPS_PROXY))}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}
process.env.HOME = runtimeHome;
process.env.DEEPSEEK_BASE_URL = payload.baseUrl;
const result = await runHostedExecution({
  rootPath: payload.rootPath,
  baseUrl: payload.baseUrl,
  execution: payload.execution,
  signal: abort.signal,
  hostSettlementTimeoutMs: payload.hostSettlementTimeoutMs,
});
const failureReason = result.failureReason;
const framedResult =
  failureReason !== undefined && Buffer.byteLength(failureReason) > 768
    ? {
        ...result,
        failureReason: new TextDecoder().decode(Buffer.from(failureReason).subarray(0, 768)),
      }
    : result;
writeRelayResult(resultToken, framedResult);
if (result.kind === 'indeterminate') process.exitCode = 1;
