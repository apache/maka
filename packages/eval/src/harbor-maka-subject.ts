import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runHostedExecution } from '@maka/runtime-host/client';
import type { HostedExecutionStartInput } from '@maka/runtime-host/protocol';
import { captureMakaRuntimeArtifacts, writeMakaArtifactCollectionError } from './maka-artifacts.js';
import { makaEvalRuntimePolicyDocument } from './maka-runtime-policy.js';
import { takeRelayResultToken, writeRelayResult } from './relay-result-frame.js';

const resultToken = takeRelayResultToken();

const payload = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString()) as {
  rootPath: string;
  artifactRoot: string;
  baseUrl: string;
  hostSettlementTimeoutMs: number;
  execution: HostedExecutionStartInput;
};
const abort = new AbortController();
let artifactCapture = Promise.resolve();
const captureArtifacts = (reason: 'settled' | 'signal') => {
  artifactCapture = artifactCapture.then(async () => {
    try {
      await captureMakaRuntimeArtifacts({
        stateRoot: payload.rootPath,
        destinationRoot: payload.artifactRoot,
        reason,
      });
    } catch (error) {
      await writeMakaArtifactCollectionError(payload.artifactRoot, error).catch(() => undefined);
    }
  });
  return artifactCapture;
};
const stop = () => {
  abort.abort();
  void captureArtifacts('signal');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const runtimeHome = join(dirname(payload.rootPath), `${process.pid}-home`);
await mkdir(payload.rootPath, { recursive: true });
await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
await writeFile(
  join(payload.rootPath, 'runtime-policy.json'),
  `${JSON.stringify(makaEvalRuntimePolicyDocument(process.env.HTTPS_PROXY))}\n`,
  { flag: 'wx', mode: 0o600 },
);
process.env.HOME = runtimeHome;
process.env.DEEPSEEK_BASE_URL = payload.baseUrl;
let result: Awaited<ReturnType<typeof runHostedExecution>>;
try {
  result = await runHostedExecution({
    rootPath: payload.rootPath,
    baseUrl: payload.baseUrl,
    execution: payload.execution,
    signal: abort.signal,
    hostSettlementTimeoutMs: payload.hostSettlementTimeoutMs,
  });
} finally {
  await captureArtifacts(abort.signal.aborted ? 'signal' : 'settled');
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
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
