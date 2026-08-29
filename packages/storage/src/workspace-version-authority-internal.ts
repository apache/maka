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

import type {
  WorkspaceBaselineAuthorityInput,
  WorkspaceBaselineCommitResult,
  WorkspaceHeadRecordV1,
} from '@maka/core/workspace-version-authority';

type WorkspaceBaselineAuthorityWriter = (
  input: WorkspaceBaselineAuthorityInput,
  rootId: string,
) => Promise<WorkspaceBaselineCommitResult>;
type WorkspaceStorageRootBinder = (rootId: string) => void;
type WorkspaceHeadReader = (
  workspaceId: string,
  workspaceEpochId: string,
) => Promise<WorkspaceHeadRecordV1 | undefined>;

interface WorkspaceBaselineAuthorityRegistration {
  readonly writer: WorkspaceBaselineAuthorityWriter;
  readonly readHead: WorkspaceHeadReader;
  readonly bindStorageRoot: WorkspaceStorageRootBinder;
  boundRootId?: string;
}

const workspaceBaselineAuthorityWriters = new WeakMap<
  object,
  WorkspaceBaselineAuthorityRegistration
>();

export function registerWorkspaceBaselineAuthorityWriterInternal(
  store: object,
  writer: WorkspaceBaselineAuthorityWriter,
  bindStorageRoot: WorkspaceStorageRootBinder,
  readHead: WorkspaceHeadReader,
): void {
  if (workspaceBaselineAuthorityWriters.has(store)) {
    throw new Error('Workspace baseline authority writer is already registered');
  }
  workspaceBaselineAuthorityWriters.set(store, {
    writer,
    readHead,
    bindStorageRoot,
  });
}

export function readWorkspaceHeadInternal(
  store: object,
  workspaceId: string,
  workspaceEpochId: string,
): Promise<WorkspaceHeadRecordV1 | undefined> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority reader is unavailable');
  return registration.readHead(workspaceId, workspaceEpochId);
}

/**
 * Storage-internal authority seam. This module is deliberately absent from the
 * @maka/storage package exports. The schema-9 reader, migration, and projection
 * rebuild remain supported even though no production baseline writer is
 * currently composed. Focused persistence tests use this seam to prove the
 * SQLite transaction and historical read contract.
 */
export function commitWorkspaceBaselineInternal(
  store: object,
  input: WorkspaceBaselineAuthorityInput,
): Promise<WorkspaceBaselineCommitResult> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority writer is unavailable');
  if (!registration.boundRootId) {
    throw new Error('Workspace baseline authority store has no durable storage-root binding');
  }
  return registration.writer(input, registration.boundRootId);
}

export function bindWorkspaceBaselineAuthorityStoreRootInternal(
  store: object,
  rootId: string,
): void {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority writer is unavailable');
  if (!/^[a-f0-9]{64}$/u.test(rootId)) {
    throw new Error('Invalid durable storage-root identity');
  }
  registration.bindStorageRoot(rootId);
  registration.boundRootId = rootId;
}
