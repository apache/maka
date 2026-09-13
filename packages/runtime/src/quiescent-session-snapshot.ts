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

import {
  createFileProductionSessionSnapshotService,
  type FileProductionSessionSnapshotService,
  type FileProductionSessionSnapshotServiceOptions,
} from '@maka/storage/production-session-snapshot';
import {
  SessionSnapshotError,
  type SessionSnapshotCancellation,
  type SessionSnapshotQuiescenceAuthority,
} from '@maka/storage/quiescent-session-snapshot';
import { SessionQuiescentMutationBusyError, type RuntimeKernelLike } from './runtime-kernel.js';

export interface RuntimeSessionSnapshotQuiescenceOptions {
  /**
   * Host/control-plane check for mutable states that RuntimeKernel does not
   * own directly, such as pending approvals, background processes, or
   * externally resumable actions. It must reject any state that could mutate
   * Session state or the workspace during the snapshot operation.
   */
  readonly assertSnapshotEligible: (
    makaSessionId: string,
    cancellation: SessionSnapshotCancellation,
  ) => Promise<void> | void;
}

export type RuntimeProductionSessionSnapshotServiceOptions = Omit<
  FileProductionSessionSnapshotServiceOptions,
  'quiescence'
> & {
  readonly kernel: Pick<RuntimeKernelLike, 'runSessionQuiescentMutation'>;
  readonly quiescence: RuntimeSessionSnapshotQuiescenceOptions;
};

/**
 * The Runtime-owned composition point for the #2369 production pipeline. A
 * control plane supplies roots, limits, and lifetime ownership; this factory
 * supplies the authoritative Runtime mutation boundary before any state or
 * workspace bytes are copied.
 */
export function createRuntimeProductionSessionSnapshotService(
  options: RuntimeProductionSessionSnapshotServiceOptions,
): Promise<FileProductionSessionSnapshotService> {
  const { kernel, quiescence, ...storageOptions } = options;

  return createFileProductionSessionSnapshotService({
    ...storageOptions,
    quiescence: createRuntimeSessionSnapshotQuiescenceAuthority(kernel, quiescence),
  });
}

/**
 * Adapts RuntimeKernel's authoritative mutation lane to the storage snapshot
 * coordinator. The callback rechecks cancellation after admission, so an
 * aborted request which was queued behind an earlier mutation performs no copy.
 */
export function createRuntimeSessionSnapshotQuiescenceAuthority(
  kernel: Pick<RuntimeKernelLike, 'runSessionQuiescentMutation'>,
  options: RuntimeSessionSnapshotQuiescenceOptions,
): SessionSnapshotQuiescenceAuthority {
  if (!kernel.runSessionQuiescentMutation) {
    throw new TypeError('Runtime Kernel does not expose Session quiescence authority');
  }
  return {
    async runQuiescent(input, operation): Promise<unknown> {
      assertActive(input.cancellation);
      try {
        return await kernel.runSessionQuiescentMutation!([input.makaSessionId], async () => {
          assertActive(input.cancellation);
          await options.assertSnapshotEligible(input.makaSessionId, input.cancellation);
          assertActive(input.cancellation);
          return operation();
        });
      } catch (error) {
        if (error instanceof SessionSnapshotError) throw error;
        if (error instanceof SessionQuiescentMutationBusyError) {
          throw new SessionSnapshotError(
            'snapshot_busy',
            'Session is busy and cannot be snapshotted',
            {
              cause: error,
              details: { phase: 'admission' },
            },
          );
        }
        // The coordinator owns normalization of failures from the admitted
        // operation. In particular, AbortError must remain visible so it is
        // reported as snapshot_cancelled rather than an admission I/O error.
        throw error;
      }
    },
  } as SessionSnapshotQuiescenceAuthority;
}

function assertActive(cancellation: SessionSnapshotCancellation): void {
  if (!cancellation.signal.aborted) return;
  throw new SessionSnapshotError(
    'snapshot_cancelled',
    'Session snapshot preparation was cancelled',
    {
      details: { phase: 'admission' },
    },
  );
}
