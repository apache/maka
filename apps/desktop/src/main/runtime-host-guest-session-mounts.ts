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
  decodeRemoteRuntimeHostProfile,
  RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES,
  RuntimeHostPermanentReconnectError,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostConnectionPhase,
  type RuntimeHostRemoteTransport,
} from '@maka/runtime-host/client';
import {
  decodeCollaborationInvitationCode,
  type HostPeerEndpoint,
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

export interface GuestSessionMount {
  readonly mountId: string;
  readonly name: string;
  readonly rootId: string;
  readonly transport: RuntimeHostRemoteTransport;
  readonly credential: string;
}

interface GuestSessionMountDocument {
  readonly schemaVersion: typeof STORE_SCHEMA_VERSION;
  readonly mounts: readonly GuestSessionMount[];
}

interface LiveGuestActivationBase {
  readonly controller: AbortController;
  stage: 'connecting' | 'finalizing';
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

export interface GuestSessionMountStore {
  read(): Promise<readonly GuestSessionMount[]>;
  write(mounts: readonly GuestSessionMount[]): Promise<void>;
}

export interface DesktopGuestSessionMountService {
  start(): Promise<void>;
  list(): Promise<readonly SessionCollaborationMountSummary[]>;
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
        mounts: [...mounts].sort((left, right) => left.mountId.localeCompare(right.mountId)),
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
    onConnectionPhase?: (phase: RuntimeHostConnectionPhase) => void,
    onPeerEndpoint?: (endpoint: HostPeerEndpoint) => void,
  ) => Promise<void>;
  readonly finalizeAccess: (
    mountId: string,
    signal: AbortSignal,
    onAccessActivated?: () => void,
  ) => Promise<RuntimeHostGuestAccessFinalization>;
  readonly unmount: (mountId: string) => Promise<void>;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly onError?: (error: Error, mount: GuestSessionMount) => void;
}): DesktopGuestSessionMountService {
  const wait = input.wait ?? waitForDelay;
  const onError = input.onError ?? ((error, mount) => {
    console.warn(`[runtime-host] shared Session ${mount.mountId} is unavailable:`, error);
  });
  const activations = new Set<LiveGuestActivation>();
  const removingMounts = new Set<string>();
  let mounts: Map<string, GuestSessionMount> | undefined;
  let mutationTail = Promise.resolve();
  let closed = false;

  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = mutationTail.then(operation);
    mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  const load = async (): Promise<Map<string, GuestSessionMount>> => {
    if (!mounts) mounts = new Map((await input.store.read()).map((mount) => [mount.mountId, mount]));
    return mounts;
  };

  const persist = async (next: Map<string, GuestSessionMount>): Promise<void> => {
    await input.store.write([...next.values()]);
    mounts = next;
  };

  const recordPeerEndpoint = (mount: GuestSessionMount, endpoint: HostPeerEndpoint): void => {
    if (
      closed ||
      mount.transport.kind !== 'libp2p-direct' ||
      endpoint.lease.peerId !== mount.transport.reachability.lease.peerId
    ) return;
    void mutate(async () => {
      if (removingMounts.has(mount.mountId)) return;
      const current = await load();
      const retained = current.get(mount.mountId);
      if (
        retained?.transport.kind !== 'libp2p-direct' ||
        retained.transport.reachability.lease.peerId !== endpoint.lease.peerId ||
        retained.transport.reachability.lease.revision >= endpoint.lease.revision
      ) return;
      const updated = decodeMount({
        ...retained,
        transport: {
          kind: 'libp2p-direct',
          reachability: endpoint,
        },
      });
      await persist(new Map(current).set(mount.mountId, updated));
    }).catch((error: unknown) => onError(asError(error), mount));
  };

  const activate = async (
    activation: LiveGuestActivation,
    mount: GuestSessionMount,
  ): Promise<RuntimeHostGuestAccessFinalization> => {
    activation.stage = 'connecting';
    await input.mount(resolveMountTarget(mount), activation.controller.signal, (phase) => {
      if (activation.kind === 'import') {
        reportImportProgress(
          activation.onProgress,
          collaborationProgressForConnectionPhase(phase),
        );
      }
    }, (endpoint) => recordPeerEndpoint(mount, endpoint));
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
    const finalization = input.finalizeAccess(
      mount.mountId,
      activation.controller.signal,
      activation.kind === 'import'
        ? () => reportImportProgress(activation.onProgress, 'loading_session')
        : undefined,
    );
    activation.finalization = finalization;
    try {
      const result = await finalization;
      activation.controller.signal.throwIfAborted();
      return result;
    } finally {
      if (activation.finalization === finalization) activation.finalization = undefined;
    }
  };

  const beginStartupReconciliation = (mount: GuestSessionMount): void => {
    if (
      closed ||
      removingMounts.has(mount.mountId) ||
      [...activations].some((activation) => activation.mountId === mount.mountId)
    ) return;
    const activation: LiveGuestActivation = {
      kind: 'startup',
      controller: new AbortController(),
      mountId: mount.mountId,
      stage: 'connecting',
      task: Promise.resolve(),
    };
    activations.add(activation);
    activation.task = (async () => {
      let delayMs = 1_000;
      while (!closed && !activation.controller.signal.aborted) {
        if (!(await load()).has(mount.mountId)) return;
        try {
          await activate(activation, mount);
          return;
        } catch (error) {
          if (
            closed ||
            activation.controller.signal.aborted ||
            removingMounts.has(mount.mountId)
          ) return;
          activation.stage = 'connecting';
          const failure = asError(error);
          onError(failure, mount);
          if (failure instanceof RuntimeHostPermanentReconnectError) return;
          await wait(delayMs, activation.controller.signal);
          delayMs = Math.min(delayMs * 2, STARTUP_RETRY_MAX_MS);
        }
      }
    })().finally(() => {
      activations.delete(activation);
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
        if (activation.stage === 'connecting') {
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
      return {
        kind: finalization === 'ready' ? 'connected' : 'recovering',
        mountId: mount.mountId,
      };
    } catch (error) {
      if (
        activation.stage === 'finalizing' &&
        error instanceof RuntimeHostPairingFinalizationInterruptedError
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
      task: Promise.resolve(),
    };
    activations.add(activation);
    const task = runImport(code, allowInsecure, activation).finally(() => {
      activations.delete(activation);
    });
    activation.task = task;
    return task;
  };

  return {
    async start() {
      if (closed) return;
      const current = await mutate(load);
      for (const mount of current.values()) beginStartupReconciliation(mount);
    },

    async list() {
      return [...(await mutate(load)).values()]
        .map(({ mountId, name }) => ({ mountId, name }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    importInvitation,

    cancelImport(operationId) {
      const operation = [...activations].find(
        (activation): activation is LiveGuestImportActivation =>
          activation.kind === 'import' && activation.operationId === operationId,
      );
      if (!operation) return 'settling';
      if (operation.stage === 'finalizing') return 'settling';
      operation.controller.abort(new Error('Shared Session import was cancelled'));
      return 'cancelled';
    },

    remove,

    async close() {
      closed = true;
      for (const activation of activations) {
        if (activation.stage === 'connecting') {
          activation.controller.abort(new Error('Shared Session mount service is closed'));
        }
      }
      await Promise.allSettled([...activations].map((activation) => activation.task));
      await mutationTail;
      activations.clear();
    },
  };
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
    service.cancelImport(requireOperationId(operationIdValue)));
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
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['mountId', 'name', 'rootId', 'transport', 'credential']) ||
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
  };
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
