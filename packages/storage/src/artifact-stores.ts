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

import type { ArtifactRecord, ArtifactSource } from '@maka/core/artifacts';
import {
  createSqliteArtifactStoreWriteAuthority,
  type ArtifactAuthorityStore,
  type ArtifactStoreWriteAuthority,
  type ConversationArtifactCopyInput,
  type ConversationArtifactCopyResult,
  type CreateArtifactInput,
  type DurableArtifactAttachmentReader,
} from './artifact-store.js';

export { sanitizeArtifactName } from './artifact-store.js';
import {
  assertStorageRootLease,
  createStorageRootLeaseIdentityGuard,
  prepareArtifactWriterLockAuthorityForLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';

export {
  createArtifactAttachmentResourceReader,
  createAttachmentByteReader,
  createReadImageSnapshotPlanner,
  createReadImageSnapshotter,
  type ArtifactAttachmentResourceReader,
  type ReadImageSnapshotPlan,
} from './artifact-attachments.js';

const writerBrand: unique symbol = Symbol('InteractiveArtifactStoreWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveArtifactStoreWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveArtifactStoreWriter>>();

export interface InteractiveArtifactStoreWriter extends DurableArtifactAttachmentReader {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  recover(): Promise<void>;
  create(input: CreateArtifactInput): Promise<ArtifactRecord>;
  /**
   * Create, reporting whether THIS call is the one that published the artifact.
   *
   * `create` is idempotent on a content-derived id: a second caller for the same
   * bytes gets the existing record back. A caller that may later reclaim what it
   * published cannot infer ownership from that success — it would reclaim an
   * artifact an earlier, already-committed projection still references. The
   * probe and the create share one write lease, so the receipt is exact.
   */
  createOwned(
    input: CreateArtifactInput,
  ): Promise<{ record: ArtifactRecord; publishedByThisCall: boolean }>;
  /**
   * Narrow system delete for one Session-owned artifact of a declared source.
   *
   * Not a user delete: the sources this serves are `userDeletable: false`
   * precisely because durable replay may depend on them. The caller must name
   * the source it believes it owns, and a mismatch throws — so a caller that is
   * wrong about what it is reclaiming reclaims nothing.
   */
  deleteOwnedArtifactInSession(
    sessionId: string,
    artifactId: string,
    source: ArtifactSource,
  ): Promise<void>;
  copyConversationArtifacts(
    input: ConversationArtifactCopyInput,
  ): Promise<ConversationArtifactCopyResult>;
  purgeSessionArtifacts(sessionId: string): Promise<void>;
  purgeRetiredCaptures: ArtifactAuthorityStore['purgeRetiredCaptures'];
  listPage: ArtifactAuthorityStore['listPage'];
  listTurnArtifacts: ArtifactAuthorityStore['listTurnArtifacts'];
  getInSession: ArtifactAuthorityStore['getInSession'];
  readTextInSession: ArtifactAuthorityStore['readTextInSession'];
  readBinaryInSession: ArtifactAuthorityStore['readBinaryInSession'];
  readChunkInSession: ArtifactAuthorityStore['readChunkInSession'];
  deleteUserArtifactInSession: ArtifactAuthorityStore['deleteUserArtifactInSession'];
  close(): void;
}

export function authenticateInteractiveArtifactStoreWriter(
  store: InteractiveArtifactStoreWriter,
): InteractiveArtifactStoreWriter {
  if (!writers.has(store)) throw invalidFacade();
  return store;
}

export async function openInteractiveArtifactStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveArtifactStoreWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    const leaseBoundWriterLockAuthority = await prepareArtifactWriterLockAuthorityForLease(
      lease,
      'interactive',
    );
    const assertAuthority = createStorageRootLeaseIdentityGuard(lease, 'interactive', 'write');
    const authority = createSqliteArtifactStoreWriteAuthority(lease.canonicalPath, {
      assertAuthority,
      leaseBoundWriterLockAuthority,
    });
    await assertStorageRootLease(lease, 'interactive', 'write');
    const recoveredExisting = writerByLease.get(lease);
    if (recoveredExisting) return recoveredExisting;
    const facade = createWriterFacade(lease, authority);
    writers.add(facade);
    writerByLease.set(lease, facade);
    return facade;
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  authority: ArtifactStoreWriteAuthority,
): InteractiveArtifactStoreWriter {
  const { store } = authority;
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'write', operation);
  const facade: InteractiveArtifactStoreWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    listPage: (sessionId, options) => run(() => store.listPage(sessionId, options)),
    listTurnArtifacts: (sessionId, turnId) => run(() => store.listTurnArtifacts(sessionId, turnId)),
    getInSession: (sessionId, artifactId) => run(() => store.getInSession(sessionId, artifactId)),
    readTextInSession: (sessionId, artifactId, options) =>
      run(() => store.readTextInSession(sessionId, artifactId, options)),
    readBinaryInSession: (sessionId, artifactId, options) =>
      run(() => store.readBinaryInSession(sessionId, artifactId, options)),
    readChunkInSession: (sessionId, artifactId, options) =>
      run(() => store.readChunkInSession(sessionId, artifactId, options)),
    readDurableAttachmentBinary: (input) => run(() => store.readDurableAttachmentBinary(input)),
    recover: () => run(() => authority.recover()),
    create: (input) => {
      const acceptedInput = snapshotCreateInput(input);
      return run(() => store.create(acceptedInput));
    },
    createOwned: (input) => {
      const acceptedInput = snapshotCreateInput(input);
      return run(async () => {
        const plannedId = acceptedInput.id;
        const existing = plannedId
          ? await store.getInSession(acceptedInput.sessionId, plannedId)
          : undefined;
        const record = await store.create(acceptedInput);
        return { record, publishedByThisCall: !existing?.record };
      });
    },
    deleteOwnedArtifactInSession: (sessionId, artifactId, source) =>
      run(async () => {
        const entry = await store.getInSession(sessionId, artifactId);
        if (!entry.record || entry.record.source !== source) {
          throw new Error('Artifact does not belong to the expected Session authority');
        }
        await store.delete(artifactId);
      }),
    copyConversationArtifacts: (input) => {
      const acceptedInput: ConversationArtifactCopyInput = Object.freeze({
        ...input,
        turnIds: Object.freeze([...input.turnIds]),
        ...(input.excludeArtifactIds
          ? { excludeArtifactIds: Object.freeze([...input.excludeArtifactIds]) }
          : {}),
        ...(input.includeArtifactIds
          ? { includeArtifactIds: Object.freeze([...input.includeArtifactIds]) }
          : {}),
        ...(input.linkedArtifacts
          ? {
              linkedArtifacts: Object.freeze(
                input.linkedArtifacts.map((linked) =>
                  Object.freeze({
                    sessionId: linked.sessionId,
                    artifactIds: Object.freeze([...linked.artifactIds]),
                  }),
                ),
              ),
            }
          : {}),
      });
      return run(() => store.copyConversationArtifacts(acceptedInput));
    },
    purgeSessionArtifacts: (sessionId) => run(() => store.purgeSessionArtifacts(sessionId)),
    purgeRetiredCaptures: (limit) => run(() => store.purgeRetiredCaptures(limit)),
    deleteUserArtifactInSession: (sessionId, artifactId) =>
      run(() => store.deleteUserArtifactInSession(sessionId, artifactId)),
    close: () => {
      if (writerByLease.get(lease) === facade) writerByLease.delete(lease);
      authority.close();
    },
  };
  return Object.freeze(facade);
}

/**
 * How much one batch deletes -- as much as it may, not as little.
 *
 * A batch costs what the store costs, not what its own size costs: the purge
 * guard resolves the path of every record it is NOT deleting, measured at
 * roughly 0.04 ms per record held, so 9,000 records cost about 370 ms whether
 * the batch deletes 256 of them or 16. That fixed cost is per batch, so a
 * smaller batch cannot shorten the wait a live turn takes -- it only makes the
 * residue take more batches, each paying the same toll again.
 *
 * The lever that does work is the pause below, which keeps the sweep out of the
 * queue for three times as long as it was in it.
 */
const RETIRED_CAPTURE_SWEEP_BATCH = 256;
const RETIRED_CAPTURE_SWEEP_PAUSE_MS = 250;
/** Keeps the sweep to a quarter of the time, however long a batch takes. */
const RETIRED_CAPTURE_SWEEP_DUTY_DIVISOR = 3;
/**
 * How many batches may fail in a row before the sweep gives up.
 *
 * Most of what fails here is not permanent. Another mutation's failure makes
 * the write authority refuse everything until something recovers it, and a
 * full or briefly unavailable disk clears on its own -- so the first failure
 * says nothing about the second. Giving up on it is how this sweep once
 * reclaimed nothing at all, for every user, without saying so.
 */
const RETIRED_CAPTURE_SWEEP_MAX_CONSECUTIVE_FAILURES = 5;
const RETIRED_CAPTURE_SWEEP_RETRY_MS = 1_000;

/**
 * Drains the prepared-request captures the retired capture sink left behind.
 *
 * The sweep shares one mutation queue with live turns, so it takes bounded
 * batches and waits between them for as long as the last one cost, rather than
 * holding the queue for the whole residue. Stopping only means the next batch
 * does not start: each batch is already durable on its own, and a later run
 * continues from what is left.
 *
 * `onError` is where the decision to repair belongs -- the sweep knows a batch
 * failed, not what would make the next one succeed.
 */
export function startRetiredCaptureSweep(
  artifacts: Pick<InteractiveArtifactStoreWriter, 'purgeRetiredCaptures'>,
  options: { readonly onError?: (error: unknown) => void | Promise<void> } = {},
): () => void {
  let stopped = false;
  void (async () => {
    let failures = 0;
    while (!stopped) {
      let pauseMs: number;
      try {
        const startedAt = Date.now();
        const { remaining } = await artifacts.purgeRetiredCaptures(RETIRED_CAPTURE_SWEEP_BATCH);
        const batchMs = Date.now() - startedAt;
        if (remaining === 0) return;
        failures = 0;
        pauseMs = Math.max(
          RETIRED_CAPTURE_SWEEP_PAUSE_MS,
          batchMs * RETIRED_CAPTURE_SWEEP_DUTY_DIVISOR,
        );
      } catch (error) {
        failures += 1;
        try {
          await options.onError?.(error);
        } catch {
          // A repair that fails leaves the same state the batch did, and the
          // failure below is already being counted.
        }
        if (failures >= RETIRED_CAPTURE_SWEEP_MAX_CONSECUTIVE_FAILURES) return;
        pauseMs = RETIRED_CAPTURE_SWEEP_RETRY_MS;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, pauseMs).unref();
      });
    }
  })();
  return () => {
    stopped = true;
  };
}

function snapshotCreateInput(input: CreateArtifactInput): CreateArtifactInput {
  return Object.freeze({
    ...input,
    content: typeof input.content === 'string' ? input.content : new Uint8Array(input.content),
  });
}

function invalidFacade(): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    'Expected authentic interactive write artifact store',
  );
}
