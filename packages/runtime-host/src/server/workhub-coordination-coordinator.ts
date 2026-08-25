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
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
  isWorkHubCoordinationSession,
  isWorkHubCoordinationSessionId,
  type SessionHeader,
} from '@maka/core/session';
import type { SessionAuthorityStore, SessionHeaderSnapshot } from '@maka/storage/session-store';
import type { OperationOutcome } from '../protocol/index.js';
import type { WorkHubCoordinationOperationHandlerMap } from './operation-dispatcher.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { SessionOperationFailure } from './session-catalog-coordinator.js';
import type { SessionContinuityCoordinator } from './session-continuity-coordinator.js';

const CREATE_FINGERPRINT = `sha256:${createHash('sha256')
  .update('maka:workhub-coordination-session:v1', 'utf8')
  .digest('hex')}`;
const COORDINATION_CWD_DIRECTORY = 'workhub-coordination';

type CoordinationStores = Pick<
  SessionAuthorityStore,
  'createStableSession' | 'probeStableSessionCreate' | 'updateHeaderVersioned'
>;

export type CoordinationCreateTarget = Omit<CreateSessionInput, 'cwd' | 'name' | 'projectId'>;

export interface HostWorkHubCoordinationCoordinatorOptions {
  readonly stateRoot: string;
  readonly stores: CoordinationStores;
  readonly admission: SessionAdmissionGate;
  readonly continuity: Pick<SessionContinuityCoordinator, 'refreshCanonical'>;
  readonly resolveCreateTarget: () => Promise<CoordinationCreateTarget>;
  readonly requestDrain: () => void;
}

/** Resolves the one durable Coordination Session owned by this Runtime Host. */
export class HostWorkHubCoordinationCoordinator {
  readonly handlers: WorkHubCoordinationOperationHandlerMap = {
    'workhub.coordination.resolve': () => this.#resolve(),
  };

  readonly #coordinationCwd: string;
  readonly #stores: CoordinationStores;
  readonly #admission: SessionAdmissionGate;
  readonly #continuity: Pick<SessionContinuityCoordinator, 'refreshCanonical'>;
  readonly #resolveCreateTarget: () => Promise<CoordinationCreateTarget>;
  readonly #requestDrain: () => void;

  constructor(options: HostWorkHubCoordinationCoordinatorOptions) {
    this.#coordinationCwd = join(options.stateRoot, COORDINATION_CWD_DIRECTORY);
    this.#stores = options.stores;
    this.#admission = options.admission;
    this.#continuity = options.continuity;
    this.#resolveCreateTarget = options.resolveCreateTarget;
    this.#requestDrain = options.requestDrain;
  }

  #resolve(): Promise<OperationOutcome<'workhub.coordination.resolve'>> {
    return this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, async (lease) => {
      // The workspace exists for provisioning and for reuse alike: a directory
      // that was pruned after creation must come back before anyone is handed
      // the identity, and mkdir is idempotent.
      try {
        await mkdir(this.#coordinationCwd, { recursive: true });
      } catch {
        return failure(
          'persistence_failed',
          'WorkHub Coordination Session workspace is unavailable',
        );
      }

      let probe;
      try {
        probe = await this.#stores.probeStableSessionCreate(
          WORKHUB_COORDINATION_SESSION_ID,
          CREATE_FINGERPRINT,
        );
      } catch {
        this.#requestDrain();
        return failure('persistence_failed', 'WorkHub Coordination Session state is unavailable');
      }

      if (probe.kind === 'existing') {
        return validCoordinationHeader(probe.record.header)
          ? await this.#alignWorkspace(probe.record)
          : identityConflict();
      }
      if (probe.kind === 'conflict') return identityConflict();

      let target: CoordinationCreateTarget;
      try {
        target = await this.#resolveCreateTarget();
      } catch (error) {
        return createTargetFailure(error);
      }

      try {
        const result = await this.#stores.createStableSession({
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          requestFingerprint: CREATE_FINGERPRINT,
          input: {
            ...target,
            cwd: this.#coordinationCwd,
            projectId: null,
            name: 'WorkHub',
            role: WORKHUB_COORDINATION_SESSION_ROLE,
          },
        });
        if (result.kind === 'conflict') return identityConflict();
        if (
          !validCoordinationHeader(result.record.header) ||
          result.record.header.cwd !== this.#coordinationCwd
        ) {
          return identityConflict();
        }
        await this.#continuity.refreshCanonical(WORKHUB_COORDINATION_SESSION_ID, lease);
        return success();
      } catch {
        this.#requestDrain();
        return failure(
          'commit_outcome_unknown',
          'WorkHub Coordination Session creation outcome is unknown',
        );
      }
    });
  }

  /**
   * The workspace path is derived from the Host state root, so it moves with the
   * installation. Identity stays in the id/role pair and the durable path is
   * repaired in place — rejecting the drift would strand the one Session no
   * ordinary lifecycle operation is allowed to relocate or retire.
   */
  async #alignWorkspace(
    record: SessionHeaderSnapshot,
  ): Promise<OperationOutcome<'workhub.coordination.resolve'>> {
    if (record.header.cwd === this.#coordinationCwd) return success();
    let repaired: SessionHeaderSnapshot;
    try {
      repaired = await this.#stores.updateHeaderVersioned(
        WORKHUB_COORDINATION_SESSION_ID,
        { cwd: this.#coordinationCwd },
        record.revision,
      );
    } catch {
      return failure(
        'persistence_failed',
        'WorkHub Coordination Session workspace could not be relocated',
      );
    }
    return validCoordinationHeader(repaired.header) && repaired.header.cwd === this.#coordinationCwd
      ? success()
      : identityConflict();
  }
}

/** Keeps a model-authority gap distinguishable from a failed authority read. */
function createTargetFailure(error: unknown): OperationOutcome<'workhub.coordination.resolve'> {
  if (error instanceof SessionOperationFailure && error.code === 'persistence_failed') {
    return failure('persistence_failed', error.message);
  }
  return failure(
    'operation_conflict',
    'WorkHub Coordination Session requires an available default model',
  );
}

function validCoordinationHeader(header: SessionHeader): boolean {
  return (
    isWorkHubCoordinationSessionId(header.id) &&
    isWorkHubCoordinationSession(header) &&
    header.projectId === null &&
    !header.isArchived &&
    header.parentSessionId === undefined &&
    header.subagentParent === undefined &&
    header.conversationCopy === undefined &&
    header.revisionRootSessionId === undefined
  );
}

function success(): OperationOutcome<'workhub.coordination.resolve'> {
  return {
    ok: true,
    result: { sessionId: WORKHUB_COORDINATION_SESSION_ID },
  };
}

function identityConflict(): OperationOutcome<'workhub.coordination.resolve'> {
  return failure('operation_conflict', 'WorkHub Coordination Session identity is unavailable');
}

function failure(
  code: Extract<
    OperationOutcome<'workhub.coordination.resolve'>,
    { readonly ok: false }
  >['error']['code'],
  message: string,
): OperationOutcome<'workhub.coordination.resolve'> {
  return { ok: false, error: { code, message } };
}
