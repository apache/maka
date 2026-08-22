/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
// Same projection as every other wrapper: the exit code reports what this
// process did, so whatever can read only the exit code reads the status the
// frame carries. Nothing decides the subject's fate from it while the frame is
// readable, but the two must not be able to say different things.
process.exitCode = result.kind === 'settled' && result.status === 'completed' ? 0 : 1;
