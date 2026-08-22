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

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createSqliteArtifactStore as createArtifactStore,
  type CreateArtifactInput,
} from '../../artifact-store.js';
import {
  withArtifactWriterLock,
  withLeaseBoundArtifactWriterLock,
} from '../../artifact-writer-lock.js';
import {
  prepareArtifactWriterLockAuthorityForLease,
  resolveExistingStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '../../root-authority.js';

const [workspaceRoot, modeOrTransientResidueSessionId, modeArgument] = process.argv.slice(2);
if (!workspaceRoot || !process.send) {
  throw new Error(
    'usage: artifact-writer-lock-holder <workspace-root> [transient-residue-session-id | --public-writer <session-id> | --authority-holder <root-id>]',
  );
}

try {
  if (modeOrTransientResidueSessionId === '--public-writer') {
    if (!modeArgument) throw new Error('public writer session id is required');
    await runPublicWriter(workspaceRoot, modeArgument);
  } else if (modeOrTransientResidueSessionId === '--authority-holder') {
    if (!modeArgument) throw new Error('authority holder root id is required');
    await runAuthorityLockHolder(workspaceRoot, modeArgument);
  } else {
    await runLockHolder(workspaceRoot, modeOrTransientResidueSessionId);
  }
} catch (error) {
  await send({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  }).catch(() => {});
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}

async function runLockHolder(
  workspaceRoot: string,
  transientResidueSessionId: string | undefined,
): Promise<void> {
  await withArtifactWriterLock(workspaceRoot, async () => {
    const residuePath = transientResidueSessionId
      ? await createTransientPublicationResidue(workspaceRoot, transientResidueSessionId)
      : undefined;
    try {
      await send({ type: 'locked' });
      await waitForRelease();
    } finally {
      if (residuePath) await rm(residuePath, { force: true });
    }
  });
  await send({ type: 'released' });
}

async function runAuthorityLockHolder(workspaceRoot: string, rootId: string): Promise<void> {
  const capability = await resolveExistingStorageRoot({
    path: workspaceRoot,
    kind: 'interactive',
    expectedRootId: rootId,
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) throw new Error('interactive storage root is already owned');
  try {
    const authority = await prepareArtifactWriterLockAuthorityForLease(owner.lease, 'interactive');
    await withLeaseBoundArtifactWriterLock(authority, async () => {
      await send({ type: 'locked' });
      await waitForRelease();
    });
    await send({ type: 'released' });
  } finally {
    await owner.close();
  }
}

async function runPublicWriter(workspaceRoot: string, sessionId: string): Promise<void> {
  const store = createArtifactStore(workspaceRoot);
  try {
    await store.list(sessionId);
    await send({ type: 'ready' });
    const command = await waitForCreateCommand();
    const mutation = store.create({
      ...command.input,
      content: repeatedPayload(command.payloadUnit, command.payloadBytes),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await send({ type: 'queued' });
    await send({ type: 'created', record: await mutation });
  } finally {
    store.close?.();
  }
}

function waitForRelease(): Promise<void> {
  return new Promise((resolve, reject) => {
    process.once('message', resolve);
    process.once('disconnect', () => reject(new Error('parent disconnected before release')));
  });
}

function waitForCreateCommand(): Promise<{
  input: Omit<CreateArtifactInput, 'content'>;
  payloadUnit: string;
  payloadBytes: number;
}> {
  return new Promise((resolve, reject) => {
    process.once('message', (message: unknown) => {
      if (!isCreateCommand(message)) {
        reject(new Error('public writer received an invalid create command'));
        return;
      }
      resolve(message);
    });
    process.once('disconnect', () =>
      reject(new Error('parent disconnected before public writer create')),
    );
  });
}

function isCreateCommand(message: unknown): message is {
  type: 'create';
  input: Omit<CreateArtifactInput, 'content'>;
  payloadUnit: string;
  payloadBytes: number;
} {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === 'create' &&
    typeof candidate.input === 'object' &&
    candidate.input !== null &&
    typeof candidate.payloadUnit === 'string' &&
    candidate.payloadUnit.length > 0 &&
    Number.isSafeInteger(candidate.payloadBytes) &&
    (candidate.payloadBytes as number) >= 0
  );
}

function repeatedPayload(unit: string, bytes: number): string {
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

async function createTransientPublicationResidue(
  workspaceRoot: string,
  sessionId: string,
): Promise<string> {
  const sessionRoot = join(workspaceRoot, 'artifacts', sessionId);
  const targetHash = createHash('sha256').update('transient.txt').digest('hex');
  const residuePath = join(
    sessionRoot,
    `.artifact-publish.${targetHash}.00000000-0000-4000-8000-000000000000.tmp`,
  );
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(residuePath, 'transient publication');
  return residuePath;
}

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
