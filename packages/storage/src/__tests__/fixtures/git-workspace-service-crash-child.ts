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

import { writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createGitWorkspaceService } from '../../git-workspace-service.js';
import { openManagedWorkspaceOwner } from '../../managed-workspace-owner.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../../root-authority.js';
import { createSqliteRuntimeStore } from '../../sqlite-runtime-store.js';

const storageRoot = requiredEnv('MAKA_GIT_WORKSPACE_STORAGE');
const gitRuntime = {
  executablePath: requiredEnv('MAKA_GIT_WORKSPACE_EXECUTABLE'),
  expectedSha256: requiredEnv('MAKA_GIT_WORKSPACE_SHA256') as `sha256:${string}`,
};
const failpoint = (point: string) => {
  if (point !== requiredEnv('MAKA_GIT_WORKSPACE_FAILPOINT')) return;
  writeSync(1, 'READY\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const request = {
  repositoryId: 'repository_11111111111111111111111111111111',
  workspaceId: 'workspace_22222222222222222222222222222222',
  workspaceEpochId: 'epoch_33333333333333333333333333333333',
  workspaceInstanceId: 'instance_44444444444444444444444444444444',
  sourceRoot: requiredEnv('MAKA_GIT_WORKSPACE_SOURCE'),
} as const;

if (process.env.MAKA_GIT_WORKSPACE_ACTION === 'baseline-receipt') {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  if (!rootOwner) throw new Error('Unable to acquire crash-child root owner');
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const owner = await openManagedWorkspaceOwner({ rootOwner, gitRuntime, failpoint });
  await owner.openManagedWorkspaceBaseline(runtimeStore, request);
  throw new Error('Managed baseline crash child missed its failpoint');
}

if (process.env.MAKA_GIT_WORKSPACE_ACTION === 'execution-admission') {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  if (!rootOwner) throw new Error('Unable to acquire crash-child root owner');
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const owner = await openManagedWorkspaceOwner({ rootOwner, gitRuntime, failpoint });
  const accepted = await owner.openManagedWorkspaceBaseline(runtimeStore, request);
  await owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => undefined);
  throw new Error('Managed execution admission crash child missed its failpoint');
}

const service = createGitWorkspaceService({
  storageRoot,
  gitRuntime,
  failpoint,
});

const binding = await service.createManagedWorkspaceFromSource(request);

if (process.env.MAKA_GIT_WORKSPACE_ACTION === 'quarantine') {
  writeFileSync(
    requiredEnv('MAKA_GIT_WORKSPACE_BINDING_OUTPUT'),
    `${JSON.stringify(binding)}\n`,
    'utf8',
  );
  await service.quarantineManagedWorkspace(binding, 'crash_convergence_test');
}

throw new Error('Git workspace crash child missed its failpoint');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
