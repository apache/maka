/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with this
 * work for additional information regarding copyright ownership. The ASF
 * licenses this file to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import type { HostManagedFilesHelper } from '../server/execution-model-composition.js';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
  GITOXIDE_HELPER_OPERATIONS_INTERNAL,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import {
  runGitoxideOperationWithinDeadlineInternal,
  GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL,
} from '../server/gitoxide-helper-invocation-internal.js';

/** Explicit developer-selected bytes, NOT an installed-release/signature trust root. */
export async function prepareManagedFilesDevHelper(
  raw: string | undefined,
): Promise<HostManagedFilesHelper> {
  const deadlineAt =
    performance.now() + GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.inspectRepositoryMs;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8192)
    throw new Error('Invalid development helper manifest');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid development helper manifest');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid development helper manifest');
  const item = value as Record<string, unknown>;
  const keys = [
    'schemaVersion',
    'executablePath',
    'expectedBytes',
    'expectedSha256',
    'platform',
    'arch',
  ];
  if (
    Object.keys(item).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(item, key)) ||
    item.schemaVersion !== 1 ||
    typeof item.executablePath !== 'string' ||
    typeof item.expectedBytes !== 'number' ||
    typeof item.expectedSha256 !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(item.expectedSha256) ||
    item.platform !== process.platform ||
    item.arch !== process.arch
  )
    throw new Error('Invalid development helper manifest');
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath: item.executablePath,
    expectedBytes: item.expectedBytes,
    expectedSha256: item.expectedSha256 as `sha256:${string}`,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
    supportedOperations: GITOXIDE_HELPER_OPERATIONS_INTERNAL,
  });
  const helperCapability = await runGitoxideOperationWithinDeadlineInternal({
    deadlineAt,
    operation: () =>
      admitGitoxideHelperArtifactInternal({ releaseOwnerToken, invocationOwnerToken, claim }),
  });
  return Object.freeze({ invocationOwnerToken, helperCapability });
}
