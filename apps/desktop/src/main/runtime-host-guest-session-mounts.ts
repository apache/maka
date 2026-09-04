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

import { randomUUID } from 'node:crypto';
import {
  abortable,
  decodeRemoteRuntimeHostProfile,
  RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES,
  RuntimeHostPermanentReconnectError,
  RuntimeHostProfileConnectionError,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostConnectionPhase,
  type RuntimeHostPeerConnectionPath,
  type RuntimeHostRemoteTransport,
} from '@maka/runtime-host/client';
import {
  decodeCollaborationInvitationCode,
  decodeSharedSessionCatalogProjection,
  type HostPeerEndpoint,
  type SharedSessionCatalogProjection,
} from '@maka/runtime-host/protocol';
import type { CredentialStore } from '@maka/storage/credential-store';
import type {
  SessionCollaborationCancelResult,
  SessionCollaborationImportPhase,
  SessionCollaborationImportResult,
  SessionCollaborationMountSummary,
} from '../shared/session-collaboration.js';
import {
  decodeDesktopCollaborationInvitation,
  DESKTOP_COLLABORATION_INVITATION_CODE_MAX_BYTES,
} from './runtime-host-collaboration-invitation.js';
import {
  RuntimeHostPairingFinalizationInterruptedError,
  type RuntimeHostGuestAccessFinalization,
} from './runtime-host-desktop-manager.js';

const STORE_SCHEMA_VERSION = 1;
const STORE_SLOT = 'desktop-guest-session-mounts';
const MAX_MOUNTS = 128;
const STARTUP_RETRY_MAX_MS = 30_000;
const DEFERRED_WRITE_RETRY_MAX_MS = 30_000;

export interface GuestSessionMount {
  readonly mountId: string;
  readonly name: string;
  readonly rootId: string;
  readonly transport: RuntimeHostRemoteTransport;
  readonly credential: string;
  readonly session?: SharedSessionCatalogProjection;
}

type GuestSessionMountReadiness = SessionCollaborationMountSummary['readiness'];

interface GuestSessionMountDocument {
  readonly schemaVersion: typeof STORE_SCHEMA_VERSION;
  readonly mounts: readonly GuestSessionMount[];
}

interface LiveGuestActivationBase {
  readonly controller: AbortController;
  stage: 'connecting' | 'finalizing' | 'hydrating';
  accessActivated: boolean;
  finalization?: Promise<RuntimeHostGuestAccessFinalization>;
  task: Promise<unknown>;
}

interface LiveGuestImportActivation extends LiveGuestActivationBase {
  readonly kind: 'import';
  readonly operationId: string;
  readonly onProgress?: (phase: SessionCollaborationImportPhase) => void;
  mountId?: string;
}

interface LiveGuestStartupActivation extends LiveGuestActivationBase {
  readonly kind: 'startup';
  readonly mountId: string;
}

type LiveGuestActivation = LiveGuestImportActivation | LiveGuestStartupActivation;

interface LiveGuestRefresh {
  dirty: boolean;
  task: Promise<void>;
}

interface DeferredWriteFailure {
  readonly mount: GuestSessionMount;
  readonly error: Error;
}

export interface GuestSessionMountStore {
  read(): Promise<readonly GuestSessionMount[]>;
  write(mounts: readonly GuestSessionMount[]): Promise<void>;
}

export interface DesktopGuestSessionMountService {
  start(): Promise<void>;
  list(): Promise<readonly SessionCollaborationMountSummary[]>;
  connectionChanged(mountId: string, error?: Error): Promise<void>;
  importInvitation(
    code: string,
    allowInsecure: boolean,
    operationId: string,
    onProgress?: (phase: SessionCollaborationImportPhase) => void,
  ): Promise<SessionCollaborationImportResult>;
  cancelImport(operationId: string): SessionCollaborationCancelResult;
  remove(mountId: string): Promise<void>;
  close(): Promise<void>;
}

export function createGuestSessionMountStore(
  credentials: Pick<CredentialStore, 'getSecret' | 'setSecret'>,
): GuestSessionMountStore {
  return {
    async read() {
      const raw = await credentials.getSecret(STORE_SLOT, 'runtime_host_access');
      if (raw === null) return [];
      return decodeDocument(JSON.parse(raw) as unknown).mounts;
    },
    async write(mounts) {
      if (mounts.length > MAX_MOUNTS) {
        throw new Error(`At most ${MAX_MOUNTS} shared Sessions can be retained`);
      }
      const document: GuestSessionMountDocument = {
        schemaVersion: STORE_SCHEMA_VERSION,
        mounts: mounts
          .map((mount) =>
            mount.session ? { ...mount, session: retainedSession(mount.session) } : mount,
          )
          .sort((left, right) => left.mountId.localeCompare(right.mountId)),
      };
      decodeDocument(document);
      await credentials.setSecret(
        STORE_SLOT,
        'runtime_host_access',
        `${JSON.stringify(document)}\n`,
      );
    },
  };
}

export function createDesktopGuestSessionMountService(input: {
  readonly store: GuestSessionMountStore;
  readonly mount: (
    target: ResolvedRuntimeHostProfile,
    signal: AbortSignal,
    onConnectionPhase: ((phase: RuntimeHostConnectionPhase) => void) | undefined,
    onPeerEndpoint: ((endpoint: HostPeerEndpoint) => void) | undefined,
    onSessionCatalogChanged: () => void,
  ) => Promise<void>;
  readonly finalizeAccess: (
    mountId: string,
    signal: AbortSignal,
    onAccessActivated?: () => void,
  ) => Promise<RuntimeHostGuestAccessFinalization>;
  readonly getSharedSession: (mountId: string) => Promise<SharedSessionCatalogProjection | null>;
  readonly inspect: (mountId: string) =>
    | {
        readonly readiness: GuestSessionMountReadiness;
        readonly peerPath?: RuntimeHostPeerConnectionPath;
      }
    | undefined;
  readonly onMountsChanged: () => void;
  readonly unmount: (mountId: string) => Promise<void>;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly onError?: (error: Error, mount: GuestSessionMount) => void;
}): DesktopGuestSessionMountService {
  const wait = input.wait ?? waitForDelay;
  const onError =
    input.onError ??
    ((error, mount) => {
      console.warn(`[runtime-host] shared Session ${mount.mountId} is unavailable:`, error);
    });
  const activations = new Set<LiveGuestActivation>();
  const removingMounts = new Set<string>();
  const invalidatedAccessMounts = new Set<string>();
  const refreshes = new Map<string, LiveGuestRefresh>();
  let mounts: Map<string, GuestSessionMount> | undefined;
  let mutationTail = Promise.resolve();
  let deferredWriteFailure: DeferredWriteFailure | undefined;
  let deferredWriteRetry: Promise<void> | undefined;
  const deferredWriteRetryController = new AbortController();
  const projectionLifetime = new AbortController();
  let closed = false;

  const readSharedSession = (
    mountId: string,
    signal?: AbortSignal,
  ): Promise<SharedSessionCatalogProjection | null> =>
    abortable(
      () => input.getSharedSession(mountId),
      signal
        ? AbortSignal.any([signal, projectionLifetime.signal])
        : projectionLifetime.signal,
    );

  const notifyMountsChanged = (): void => {
    try {
      input.onMountsChanged();
    } catch {
      // Renderer invalidation cannot control the durable mount lifecycle.
    }
  };

  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = mutationTail.then(operation);
    mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  const load = async (): Promise<Map<string, GuestSessionMount>> => {
    if (!mounts)
      mounts = new Map((await input.store.read()).map((mount) => [mount.mountId, mount]));
    return mounts;
  };

  const persistDeferredState = async (
    current: Map<string, GuestSessionMount>,
    changedMount?: GuestSessionMount,
  ): Promise<Error | undefined> => {
    const failureMount = changedMount ?? deferredWriteFailure?.mount;
    if (!failureMount) return undefined;
    try {
      await input.store.write([...current.values()]);
      deferredWriteFailure = undefined;
      return undefined;
    } catch (error) {
      const failure = asError(error);
      deferredWriteFailure = { mount: failureMount, error: failure };
      return failure;
    }
  };

  const flushDeferredWrite = (): Promise<Error | undefined> =>
    mutate(async () => persistDeferredState(await load()));

  const scheduleDeferredWriteRetry = (): void => {
    if (closed || deferredWriteRetry) return;
    deferredWriteRetry = (async () => {
      let delayMs = 1_000;
      while (!closed && deferredWriteFailure) {
        try {
          await wait(delayMs, deferredWriteRetryController.signal);
        } catch {
          return;
        }
        if (!(await flushDeferredWrite())) return;
        delayMs = Math.min(delayMs * 2, DEFERRED_WRITE_RETRY_MAX_MS);
      }
    })().finally(() => {
      deferredWriteRetry = undefined;
      // Do not lose a failure installed while the prior task settled.
      if (!closed && deferredWriteFailure) scheduleDeferredWriteRetry();
    });
  };

  const persist = async (next: Map<string, GuestSessionMount>): Promise<void> => {
    await input.store.write([...next.values()]);
    mounts = next;
    deferredWriteFailure = undefined;
  };

  const clearSessionProjection = async (mountId: string): Promise<void> => {
    // This fence is installed before the durable mutation is queued so a
    // concurrent refresh cannot restore a projection after authority loss.
    invalidatedAccessMounts.add(mountId);
    await mutate(async () => {
      const current = await load();
      const mount = current.get(mountId);
      if (!mount) {
        invalidatedAccessMounts.delete(mountId);
        return;
      }
      let next = current;
      if (mount.session) {
        next = new Map(current).set(mountId, {
          mountId: mount.mountId,
          name: mount.name,
          rootId: mount.rootId,
          transport: mount.transport,
          credential: mount.credential,
        });
        // Authority loss takes effect in memory before a fallible credential
        // store write. A locked or unavailable store must never keep exposing
        // a projection whose credential has already been rejected.
        mounts = next;
      }
      notifyMountsChanged();
      if (!mount.session && !deferredWriteFailure) return;
      const error = await persistDeferredState(next, mount.session ? mount : undefined);
      if (error) {
        scheduleDeferredWriteRetry();
        throw error;
      }
    });
  };

  const recordPeerEndpoint = (mount: GuestSessionMount, endpoint: HostPeerEndpoint): void => {
    if (
      closed ||
      mount.transport.kind !== 'libp2p-direct' ||
      endpoint.lease.peerId !== mount.transport.reachability.lease.peerId
    )
      return;
    void mutate(async () => {
      if (removingMounts.has(mount.mountId)) return;
      const current = await load();
      const retained = current.get(mount.mountId);
      if (
        retained?.transport.kind !== 'libp2p-direct' ||
        retained.transport.reachability.lease.peerId !== endpoint.lease.peerId ||
        retained.transport.reachability.lease.revision >= endpoint.lease.revision
      )
        return;
      const updated: GuestSessionMount = {
        ...retained,
        transport: {
          kind: 'libp2p-direct',
          reachability: endpoint,
        },
      };
      const next = new Map(current).set(mount.mountId, updated);
      // The authenticated endpoint is immediately useful to reconnect logic;
      // a transient credential-store lock must not discard it.
      mounts = next;
      const error = await persistDeferredState(next, mount);
      if (error) {
        scheduleDeferredWriteRetry();
        throw error;
      }
    }).catch((error: unknown) => onError(asError(error), mount));
  };

  const recordSharedSession = async (
    mount: GuestSessionMount,
    session: SharedSessionCatalogProjection,
  ): Promise<void> => {
    if (invalidatedAccessMounts.has(mount.mountId)) {
      throw new RuntimeHostPermanentReconnectError('Shared Session access is no longer available');
    }
    const superseded = await mutate(async () => {
      if (invalidatedAccessMounts.has(mount.mountId)) {
        throw new RuntimeHostPermanentReconnectError(
          'Shared Session access is no longer available',
        );
      }
      const current = await load();
      const retained = current.get(mount.mountId);
      if (!retained) throw new Error('Shared Session mount was removed while connecting');
      const next = new Map(current);
      const duplicates: GuestSessionMount[] = [];
      for (const candidate of current.values()) {
        if (
          candidate.mountId === mount.mountId ||
          candidate.rootId !== mount.rootId ||
          candidate.session?.id !== session.id
        )
          continue;
        duplicates.push(candidate);
        next.delete(candidate.mountId);
      }
      next.set(mount.mountId, { ...retained, session });
      // The authenticated projection is a live cache, not the access grant.
      // Publish it even when the credential store is temporarily locked, then
      // retry the durable cache write without holding UI freshness.
      mounts = next;
      notifyMountsChanged();
      const error = await persistDeferredState(next, mount);
      if (error) {
        scheduleDeferredWriteRetry();
        onError(error, mount);
      }
      return duplicates;
    });
    for (const duplicate of superseded) {
      void input.unmount(duplicate.mountId).catch((error) => onError(asError(error), duplicate));
    }
    if (invalidatedAccessMounts.has(mount.mountId)) {
      throw new RuntimeHostPermanentReconnectError('Shared Session access is no longer available');
    }
  };

  const refreshOnce = async (mountId: string): Promise<void> => {
    if (removingMounts.has(mountId) || invalidatedAccessMounts.has(mountId)) return;
    // A catalog change may arrive after activation read its projection but
    // before that projection is committed. Wait for the admitted activation
    // and read again so the later authoritative state cannot be lost. Once
    // admitted, shutdown cancels the cache read without affecting access.
    while (true) {
      const activation = [...activations].find((candidate) => candidate.mountId === mountId);
      if (!activation) break;
      await activation.task.catch(() => undefined);
      if (removingMounts.has(mountId) || invalidatedAccessMounts.has(mountId)) return;
    }
    const mount = (await mutate(load)).get(mountId);
    if (!mount) return;
    const inspected = input.inspect(mountId);
    if (inspected && inspected.readiness !== 'ready') return;
    const session = await readSharedSession(mountId);
    if (removingMounts.has(mountId) || invalidatedAccessMounts.has(mountId)) return;
    if (!session) {
      await clearSessionProjection(mountId);
      return;
    }
    await recordSharedSession(mount, session);
  };

  const refresh = (mountId: string): Promise<void> => {
    if (closed) return Promise.resolve();
    const active = refreshes.get(mountId);
    if (active) {
      active.dirty = true;
      return active.task;
    }
    const state: LiveGuestRefresh = { dirty: true, task: Promise.resolve() };
    state.task = (async () => {
      let failure: unknown;
      do {
        state.dirty = false;
        try {
          await refreshOnce(mountId);
          failure = undefined;
        } catch (error) {
          failure = error;
        }
      } while (state.dirty);
      if (failure !== undefined) throw failure;
    })().finally(() => {
      if (refreshes.get(mountId) === state) refreshes.delete(mountId);
    });
    refreshes.set(mountId, state);
    return state.task;
  };

  const activate = async (
    activation: LiveGuestActivation,
    mount: GuestSessionMount,
  ): Promise<RuntimeHostGuestAccessFinalization> => {
    activation.stage = 'connecting';
    await input.mount(
      resolveMountTarget(mount),
      activation.controller.signal,
      (phase) => {
        if (activation.kind === 'import') {
          reportImportProgress(
            activation.onProgress,
            collaborationProgressForConnectionPhase(phase),
          );
        }
      },
      (endpoint) => recordPeerEndpoint(mount, endpoint),
      () => {
        // The candidate publishes the live Session event. Refresh this
        // durable projection independently; its eventual inventory change
        // remains useful even when the credential-store write must retry.
        void refresh(mount.mountId).catch((error: unknown) => onError(asError(error), mount));
      },
    );
    // waitForReady observes host.status before mount resolves. Commit that
    // authenticated route snapshot before declaring the durable mount ready.
    await mutationTail;
    activation.controller.signal.throwIfAborted();
    if (removingMounts.has(mount.mountId)) {
      throw new Error('Shared Session mount was removed while connecting');
    }
    activation.stage = 'finalizing';
    if (activation.kind === 'import') {
      reportImportProgress(activation.onProgress, 'finalizing_access');
    }
    const finalization = (async (): Promise<RuntimeHostGuestAccessFinalization> => {
      const result = await input.finalizeAccess(mount.mountId, activation.controller.signal, () => {
        activation.accessActivated = true;
        if (activation.kind === 'import') {
          reportImportProgress(activation.onProgress, 'loading_session');
        }
      });
      activation.accessActivated = true;
      activation.controller.signal.throwIfAborted();
      if (result === 'ready') {
        activation.stage = 'hydrating';
        if (closed || removingMounts.has(mount.mountId)) {
          return result;
        }
        const session = await readSharedSession(mount.mountId, activation.controller.signal);
        activation.controller.signal.throwIfAborted();
        if (!session) {
          await clearSessionProjection(mount.mountId);
          throw new RuntimeHostPermanentReconnectError(
            'This shared Session is no longer available to the retained Guest access',
          );
        }
        await recordSharedSession(mount, session);
      } else {
        activation.stage = 'connecting';
      }
      return result;
    })();
    activation.finalization = finalization;
    try {
      return await finalization;
    } finally {
      if (activation.finalization === finalization) activation.finalization = undefined;
    }
  };

  const beginStartupReconciliation = (mount: GuestSessionMount): void => {
    if (
      closed ||
      removingMounts.has(mount.mountId) ||
      [...activations].some((activation) => activation.mountId === mount.mountId)
    )
      return;
    const activation: LiveGuestActivation = {
      kind: 'startup',
      controller: new AbortController(),
      mountId: mount.mountId,
      stage: 'connecting',
      accessActivated: false,
      task: Promise.resolve(),
    };
    activations.add(activation);
    activation.task = (async () => {
      let delayMs = 1_000;
      while (!closed && !activation.controller.signal.aborted) {
        if (!(await load()).has(mount.mountId)) return;
        try {
          const result = await activate(activation, mount);
          if (result === 'ready') return;
          if (closed || activation.controller.signal.aborted || removingMounts.has(mount.mountId))
            return;
          await wait(delayMs, activation.controller.signal);
          delayMs = Math.min(delayMs * 2, STARTUP_RETRY_MAX_MS);
        } catch (error) {
          if (closed || activation.controller.signal.aborted || removingMounts.has(mount.mountId))
            return;
          activation.stage = 'connecting';
          const failure = asError(error);
          onError(failure, mount);
          if (isRejectedAccessFailure(failure)) {
            await clearSessionProjection(mount.mountId);
            return;
          }
          if (failure instanceof RuntimeHostPermanentReconnectError) {
            return;
          }
          await wait(delayMs, activation.controller.signal);
          delayMs = Math.min(delayMs * 2, STARTUP_RETRY_MAX_MS);
        }
      }
    })().finally(() => {
      activations.delete(activation);
      notifyMountsChanged();
    });
    void activation.task.catch((error) => {
      if (!activation.controller.signal.aborted) onError(asError(error), mount);
    });
  };

  const remove = async (mountId: string): Promise<void> => {
    removingMounts.add(mountId);
    try {
      const matching = [...activations].filter((activation) => activation.mountId === mountId);
      for (const activation of matching) {
        if (activation.stage !== 'finalizing') {
          activation.controller.abort(new Error('Shared Session mount was removed'));
        }
      }
      await Promise.allSettled(
        matching.flatMap((activation) =>
          activation.finalization ? [activation.finalization] : [],
        ),
      );
      const removed = await mutate(async () => {
        const current = await load();
        const mount = current.get(mountId);
        if (!mount) return undefined;
        const next = new Map(current);
        next.delete(mountId);
        await persist(next);
        return mount;
      });
      if (!removed) return;
      invalidatedAccessMounts.delete(mountId);
      notifyMountsChanged();
      for (const activation of activations) {
        if (activation.mountId === mountId) {
          activation.controller.abort(new Error('Shared Session mount was removed'));
        }
      }
      void input.unmount(mountId).catch((error) => onError(asError(error), removed));
    } finally {
      removingMounts.delete(mountId);
    }
  };

  const runImport = async (
    code: string,
    allowInsecure: boolean,
    activation: LiveGuestImportActivation,
  ): Promise<SessionCollaborationImportResult> => {
    reportImportProgress(activation.onProgress, 'validating_invitation');
    activation.controller.signal.throwIfAborted();
    let bundle;
    let invitation;
    try {
      bundle = decodeDesktopCollaborationInvitation(code);
      invitation = decodeCollaborationInvitationCode(bundle.invitationCode);
    } catch {
      return { kind: 'error', reason: 'invalid_code' };
    }
    if (bundle.target.transport.kind === 'plaintext' && !allowInsecure) {
      return { kind: 'error', reason: 'insecure_confirmation_required' };
    }
    const mount = decodeMount({
      mountId: `shared-${randomUUID()}`,
      name: `${bundle.target.name} · Shared`,
      rootId: invitation.rootId,
      transport: bundle.target.transport,
      credential: invitation.credential,
    });
    activation.mountId = mount.mountId;
    const retained = await mutate(async () => {
      activation.controller.signal.throwIfAborted();
      const current = await load();
      if (current.size >= MAX_MOUNTS) return false;
      await persist(new Map(current).set(mount.mountId, mount));
      return true;
    });
    if (!retained) {
      return {
        kind: 'error',
        reason: 'connection_failed',
        message: `At most ${MAX_MOUNTS} shared Sessions can be retained`,
      };
    }
    let reconcile = false;
    try {
      reportImportProgress(activation.onProgress, 'discovering_host');
      const finalization = await activate(activation, mount);
      activation.controller.signal.throwIfAborted();
      if (!(await load()).has(mount.mountId)) {
        throw new Error('Shared Session mount was removed while connecting');
      }
      reconcile = finalization === 'reconnecting';
      return {
        kind: finalization === 'ready' ? 'connected' : 'recovering',
        mountId: mount.mountId,
      };
    } catch (error) {
      if (
        (activation.stage === 'finalizing' &&
          error instanceof RuntimeHostPairingFinalizationInterruptedError) ||
        (activation.accessActivated && !(error instanceof RuntimeHostPermanentReconnectError))
      ) {
        reconcile = true;
      } else {
        await mutate(async () => {
          const next = new Map(await load());
          next.delete(mount.mountId);
          await persist(next);
        });
        activation.controller.abort(new Error('Shared Session mount activation failed'));
        await input.unmount(mount.mountId).catch(() => undefined);
        invalidatedAccessMounts.delete(mount.mountId);
      }
      return reconcile
        ? { kind: 'recovering', mountId: mount.mountId }
        : {
            kind: 'error',
            reason: isPeerPathUnavailable(error) ? 'peer_path_unavailable' : 'connection_failed',
            message: asError(error).message,
          };
    } finally {
      activations.delete(activation);
      if (reconcile) beginStartupReconciliation(mount);
      notifyMountsChanged();
    }
  };

  const importInvitation = (
    code: string,
    allowInsecure: boolean,
    operationId: string,
    onProgress?: (phase: SessionCollaborationImportPhase) => void,
  ): Promise<SessionCollaborationImportResult> => {
    if (closed) return Promise.reject(new Error('Shared Session mount service is closed'));
    if (
      [...activations].some(
        (activation) => activation.kind === 'import' && activation.operationId === operationId,
      )
    ) {
      return Promise.reject(new Error('Shared Session import operation is already active'));
    }
    const activation: LiveGuestImportActivation = {
      kind: 'import',
      operationId,
      ...(onProgress ? { onProgress } : {}),
      controller: new AbortController(),
      stage: 'connecting',
      accessActivated: false,
      task: Promise.resolve(),
    };
    activations.add(activation);
    const task = runImport(code, allowInsecure, activation);
    activation.task = task;
    return task;
  };

  return {
    async start() {
      if (closed) return;
      const current = await mutate(load);
      for (const mount of current.values()) {
        beginStartupReconciliation(mount);
      }
    },

    async list() {
      // Projection updates replace the whole Map before notifying readers, so
      // an initialized snapshot is safe to read while its cache write settles.
      const current = mounts ?? (await mutate(load));
      return [...current.values()]
        .map((mount) => {
          const inspected = input.inspect(mount.mountId);
          const activation = [...activations].find(
            (candidate) => candidate.mountId === mount.mountId,
          );
          const currentReadiness = deriveMountReadiness({
            accessInvalidated: invalidatedAccessMounts.has(mount.mountId),
            activationKind: activation?.kind,
            activationAccessActivated: activation?.accessActivated === true,
            connectionReadiness: inspected?.readiness,
            hasSessionProjection: mount.session !== undefined,
          });
          return {
            mountId: mount.mountId,
            name: mount.name,
            hostId: mount.rootId,
            readiness: currentReadiness,
            ...(inspected?.peerPath ? { peerPath: inspected.peerPath } : {}),
            ...(!invalidatedAccessMounts.has(mount.mountId) && mount.session
              ? { session: mount.session }
              : {}),
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async connectionChanged(mountId, error) {
      if (closed) return;
      if (error && isRejectedAccessFailure(error)) {
        await clearSessionProjection(mountId);
        return;
      }
      notifyMountsChanged();
      if (input.inspect(mountId)?.readiness !== 'ready') return;
      // Initial activation owns its authenticated projection hydration. A
      // later ready transition means a reconnect completed and needs a fresh
      // projection from the recovered Host.
      if ([...activations].some((activation) => activation.mountId === mountId)) return;
      await refresh(mountId);
    },

    importInvitation,

    cancelImport(operationId) {
      const operation = [...activations].find(
        (activation): activation is LiveGuestImportActivation =>
          activation.kind === 'import' && activation.operationId === operationId,
      );
      if (!operation) return 'settling';
      if (operation.stage !== 'connecting') return 'settling';
      operation.controller.abort(new Error('Shared Session import was cancelled'));
      return 'cancelled';
    },

    remove,

    async close() {
      closed = true;
      projectionLifetime.abort(new Error('Shared Session mount service is closed'));
      deferredWriteRetryController.abort(
        new Error('Shared Session mount service is closed'),
      );
      for (const activation of activations) {
        if (activation.stage !== 'finalizing') {
          activation.controller.abort(new Error('Shared Session mount service is closed'));
        }
      }
      await Promise.allSettled([...activations].map((activation) => activation.task));
      await Promise.allSettled([...refreshes.values()].map((refresh) => refresh.task));
      if (deferredWriteRetry) await deferredWriteRetry;
      await mutationTail;
      if (deferredWriteFailure) {
        await flushDeferredWrite();
        if (deferredWriteFailure) {
          onError(deferredWriteFailure.error, deferredWriteFailure.mount);
        }
      }
      activations.clear();
      refreshes.clear();
    },
  };
}

function deriveMountReadiness(input: {
  readonly accessInvalidated: boolean;
  readonly activationKind?: LiveGuestActivation['kind'];
  readonly activationAccessActivated: boolean;
  readonly connectionReadiness?: GuestSessionMountReadiness;
  readonly hasSessionProjection: boolean;
}): GuestSessionMountReadiness {
  if (input.accessInvalidated || input.connectionReadiness === 'unavailable') {
    return 'unavailable';
  }
  if (
    input.connectionReadiness === 'ready' &&
    input.hasSessionProjection &&
    (!input.activationKind || input.activationAccessActivated)
  ) {
    return 'ready';
  }
  if (input.activationKind === 'import') return 'connecting';
  if (input.activationKind === 'startup') return 'reconnecting';
  if (input.connectionReadiness === 'ready') return 'reconnecting';
  return input.connectionReadiness ?? 'reconnecting';
}

export function registerDesktopGuestSessionMountIpc(
  ipcMain: Pick<Electron.IpcMain, 'handle' | 'removeHandler'>,
  service: DesktopGuestSessionMountService,
  readClipboardText: () => string,
): () => void {
  const channels = [
    'session-collaboration:import',
    'session-collaboration:import:cancel',
    'session-collaboration:mount:list',
    'session-collaboration:mount:remove',
    'session-collaboration:invitation:read-clipboard',
  ] as const;
  ipcMain.handle(
    channels[0],
    (event, code: string, allowInsecure: boolean, operationIdValue: unknown) => {
      const operationId = requireOperationId(operationIdValue);
      return service.importInvitation(code, allowInsecure, operationId, (phase) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('session-collaboration:import:progress', operationId, phase);
        }
      });
    },
  );
  ipcMain.handle(channels[1], (_event, operationIdValue: unknown) =>
    service.cancelImport(requireOperationId(operationIdValue)),
  );
  ipcMain.handle(channels[2], () => service.list());
  ipcMain.handle(channels[3], (_event, mountId: string) => service.remove(mountId));
  ipcMain.handle(channels[4], () => {
    const value = readClipboardText().trim();
    if (Buffer.byteLength(value, 'utf8') > DESKTOP_COLLABORATION_INVITATION_CODE_MAX_BYTES) {
      throw new Error('Clipboard content is too large to be a shared Session invitation');
    }
    if (!value) return value;
    decodeDesktopCollaborationInvitation(value);
    return value;
  });
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

function resolveMountTarget(mount: GuestSessionMount): ResolvedRuntimeHostProfile {
  return {
    profile: decodeRemoteRuntimeHostProfile({
      id: mount.mountId,
      name: mount.name,
      kind: 'remote',
      rootId: mount.rootId,
      transport: mount.transport,
      access: 'session_guest',
    }),
    credential: mount.credential,
  };
}

function decodeDocument(value: unknown): GuestSessionMountDocument {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'mounts'])) {
    throw new Error('Shared Session mount store is invalid');
  }
  if (value.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(value.mounts)) {
    throw new Error('Shared Session mount store version is unsupported');
  }
  if (value.mounts.length > MAX_MOUNTS) {
    throw new Error(`Shared Session mount store exceeds ${MAX_MOUNTS} entries`);
  }
  const mounts = value.mounts.map(decodeMount);
  if (new Set(mounts.map((mount) => mount.mountId)).size !== mounts.length) {
    throw new Error('Shared Session mount identities must be unique');
  }
  return { schemaVersion: STORE_SCHEMA_VERSION, mounts };
}

function decodeMount(value: unknown): GuestSessionMount {
  const keys = ['mountId', 'name', 'rootId', 'transport', 'credential'];
  if (isRecord(value) && value.session !== undefined) keys.push('session');
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    typeof value.credential !== 'string' ||
    !value.credential ||
    /\s/u.test(value.credential) ||
    Buffer.byteLength(value.credential, 'utf8') > RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES
  ) {
    throw new Error('Shared Session mount is invalid');
  }
  const target = decodeRemoteRuntimeHostProfile({
    id: value.mountId,
    name: value.name,
    kind: 'remote',
    rootId: value.rootId,
    transport: value.transport,
    access: 'session_guest',
  });
  return {
    mountId: target.id,
    name: target.name,
    rootId: target.rootId,
    transport: target.transport,
    credential: value.credential,
    ...(value.session === undefined
      ? {}
      : {
          session: retainedSession(decodeSharedSessionCatalogProjection(value.session)),
        }),
  };
}

function retainedSession(session: SharedSessionCatalogProjection): SharedSessionCatalogProjection {
  const { liveRunState: _liveRunState, ...retained } = session;
  return retained;
}

function isRejectedAccessFailure(error: Error): boolean {
  return (
    error instanceof RuntimeHostProfileConnectionError && error.reason === 'credential_rejected'
  );
}

function isPeerPathUnavailable(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== 'string') return false;
  return (
    error.code === 'direct_path_unavailable' ||
    error.code === 'transit_unavailable' ||
    error.code === 'peer_reachability_needs_repair'
  );
}

function collaborationProgressForConnectionPhase(
  phase: RuntimeHostConnectionPhase,
): SessionCollaborationImportPhase {
  switch (phase) {
    case 'discovering':
      return 'preparing_route';
    case 'connecting':
      return 'connecting';
    case 'authenticating':
    case 'handshaking':
    case 'waiting_for_ready':
      return 'authenticating';
  }
}

function reportImportProgress(
  observer: ((phase: SessionCollaborationImportPhase) => void) | undefined,
  phase: SessionCollaborationImportPhase,
): void {
  try {
    observer?.(phase);
  } catch {
    // Presentation progress cannot control the import lifecycle.
  }
}

function requireOperationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error('Shared Session import operation ID is invalid');
  }
  return value;
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    }
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
