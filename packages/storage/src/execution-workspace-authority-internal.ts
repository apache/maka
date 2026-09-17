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

import type {
  WorkspaceBaselineAuthorityInput,
  WorkspaceBaselineCommitResult,
  WorkspaceHeadRecordV1,
  WorkspaceEpochRecordV1,
  WorkspaceVersionRecordV1,
  WorkspaceSuccessorAuthorityInput,
} from '@maka/core/workspace-version-authority';
import type {
  ManagedMutationNoEffectClaimV1,
  ManagedMutationReservationRecordV1,
  ManagedMutationTerminalCommitInput,
  ManagedMutationTerminalCommitResult,
  WorkspaceSuccessorCommitInput,
  WorkspaceSuccessorCommitResult,
} from './workspace-version-authority-internal.js';

/** Trusted Host composition only; never sourced from a tool request. */
export interface ExecutionWorkspaceProofVerifiers {
  baseline(proof: object): WorkspaceBaselineAuthorityInput;
  successor(proof: object): WorkspaceSuccessorAuthorityInput;
  noEffect(proof: object): ManagedMutationNoEffectClaimV1;
}

export interface ExecutionWorkspaceAuthority {
  commitBaseline(proof: object): Promise<WorkspaceBaselineCommitResult>;
  commitSuccessor(input: WorkspaceSuccessorCommitInput): Promise<WorkspaceSuccessorCommitResult>;
  commitNoEffect(
    input: ManagedMutationTerminalCommitInput,
  ): Promise<ManagedMutationTerminalCommitResult>;
  readHead(workspaceId: string, epochId: string): Promise<WorkspaceHeadRecordV1 | undefined>;
  readEpoch(workspaceId: string, epochId: string): Promise<WorkspaceEpochRecordV1 | undefined>;
  readVersion(versionId: string): Promise<WorkspaceVersionRecordV1 | undefined>;
  readReservation(instanceId: string): Promise<ManagedMutationReservationRecordV1 | undefined>;
}

type Runner = <T>(operation: () => Promise<T>) => Promise<T>;
type Opener = (verifiers: ExecutionWorkspaceProofVerifiers) => Promise<ExecutionWorkspaceAuthority>;
const openers = new WeakMap<object, Opener>();

export function registerExecutionWorkspaceAuthorityInternal(
  stores: object,
  run: Runner,
  openBackend: Opener | undefined,
): void {
  let selected: ExecutionWorkspaceProofVerifiers | undefined;
  let pending: Promise<ExecutionWorkspaceAuthority> | undefined;
  openers.set(stores, (verifiers) =>
    run(async () => {
      if (!openBackend) throw new Error('Execution provider has no workspace authority');
      if (selected && selected !== verifiers)
        throw new Error('Workspace proof owner is already selected');
      if (!pending) {
        selected = verifiers;
        const snapshot = Object.freeze({
          baseline: verifiers.baseline.bind(verifiers),
          successor: verifiers.successor.bind(verifiers),
          noEffect: verifiers.noEffect.bind(verifiers),
        });
        pending = openBackend(snapshot).then((backend) =>
          Object.freeze({
            commitBaseline: (proof: object) => run(() => backend.commitBaseline(proof)),
            commitSuccessor: (input: WorkspaceSuccessorCommitInput) =>
              run(() => backend.commitSuccessor(input)),
            commitNoEffect: (input: ManagedMutationTerminalCommitInput) =>
              run(() => backend.commitNoEffect(input)),
            readHead: (workspaceId: string, epochId: string) =>
              run(() => backend.readHead(workspaceId, epochId)),
            readEpoch: (workspaceId: string, epochId: string) =>
              run(() => backend.readEpoch(workspaceId, epochId)),
            readVersion: (versionId: string) => run(() => backend.readVersion(versionId)),
            readReservation: (instanceId: string) => run(() => backend.readReservation(instanceId)),
          }),
        );
      }
      return pending;
    }),
  );
}

/** Authentic group required. Consumed through the execution-stores composition surface. */
export async function openExecutionWorkspaceAuthorityInternal(
  stores: object,
  verifiers: ExecutionWorkspaceProofVerifiers,
): Promise<ExecutionWorkspaceAuthority> {
  const open = openers.get(stores);
  if (!open) throw new Error('Unrecognized execution stores');
  return open(verifiers);
}
