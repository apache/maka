import type { IpcMain } from 'electron';
import type { SessionChangedEvent, SessionChangedReason } from '@maka/core';
import type { BotRegistry } from '@maka/runtime';
import {
  connectOrSpawnRuntimeHost,
  type ConnectOrSpawnRuntimeHostInput,
  type ConnectOrSpawnRuntimeHostResult,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import type { AttachmentApprovalRegistry } from './attachment-approval.js';
import { createBotIncomingMainService, type BotIncomingMainService } from './bot-incoming-main.js';
import { createRuntimeHostBotSessionAdapter } from './runtime-host-bot-session-adapter.js';
import { DesktopRuntimeHostClient } from './runtime-host-client.js';
import {
  createDesktopNativeCapabilityProvider,
  type DesktopNativeCapabilityProvider,
  type DesktopNativeCapabilityProviderInput,
} from './runtime-host-native-capabilities.js';
import { registerRuntimeHostSessionCatalogIpc } from './runtime-host-session-catalog-ipc-main.js';
import {
  registerRuntimeHostSessionDomainsIpc,
  type RuntimeHostSessionDomainsIpcDeps,
} from './runtime-host-session-domains-ipc-main.js';
import { registerRuntimeHostSessionExecutionIpc } from './runtime-host-session-execution-ipc-main.js';
import { RuntimeHostSessionObserver } from './runtime-host-session-observer.js';

type CandidateIpcMain = Pick<IpcMain, 'handle' | 'removeHandler'>;

export interface DesktopRuntimeHostCandidateDeps {
  readonly ipcMain: CandidateIpcMain;
  readonly workspaceRoot: string;
  readonly attachmentApprovals: AttachmentApprovalRegistry;
  readonly stat: (path: string) => Promise<{ size: number }>;
  readonly resizeImage: (bytes: Uint8Array) => Promise<Uint8Array>;
  readonly nativeCapabilities: DesktopNativeCapabilityProviderInput;
  readonly botRegistry: BotRegistry;
  readonly resolveBotCreateTarget: () => Promise<{
    readonly cwd: string;
    readonly projectId?: string | null;
  }>;
  readonly emitSessionsChanged: (
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, 'connectionSlug' | 'modelId' | 'turnId'>,
  ) => void;
  readonly emitModeChanged: RuntimeHostSessionDomainsIpcDeps['emitModeChanged'];
  readonly sendToRenderer?: RuntimeHostSessionDomainsIpcDeps['sendToRenderer'];
  readonly onError?: RuntimeHostSessionDomainsIpcDeps['onError'];
  readonly newId?: () => string;
  readonly now?: () => number;
}

export interface DesktopRuntimeHostCandidateStartInput extends DesktopRuntimeHostCandidateDeps {
  readonly rootPath: string;
  readonly clientInstanceId?: string;
  readonly electionDeadlineMs?: number;
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
}

export type DesktopRuntimeHostCandidateStartResult =
  | {
      readonly kind: 'ready';
      readonly candidate: DesktopRuntimeHostCandidate;
    }
  | Exclude<ConnectOrSpawnRuntimeHostResult, { kind: 'connected' }>;

export interface DesktopRuntimeHostCandidate {
  readonly botIncoming: BotIncomingMainService;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

class DesktopRuntimeHostCandidateImpl implements DesktopRuntimeHostCandidate {
  readonly botIncoming: BotIncomingMainService;
  readonly closed: Promise<void>;
  readonly #client: DesktopRuntimeHostClient;
  readonly #observer: RuntimeHostSessionObserver;
  readonly #ipc: ScopedIpcMain;
  readonly #botIncoming: BotIncomingMainService;
  readonly #nativeCapabilities: DesktopNativeCapabilityProvider;
  readonly #capabilitiesRegistered: boolean;
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    client: DesktopRuntimeHostClient;
    observer: RuntimeHostSessionObserver;
    ipc: ScopedIpcMain;
    botIncoming: BotIncomingMainService;
    nativeCapabilities: DesktopNativeCapabilityProvider;
    connectionClosed: Promise<void>;
    capabilitiesRegistered: boolean;
  }) {
    this.#client = input.client;
    this.#observer = input.observer;
    this.#ipc = input.ipc;
    this.#botIncoming = input.botIncoming;
    this.#nativeCapabilities = input.nativeCapabilities;
    this.#capabilitiesRegistered = input.capabilitiesRegistered;
    this.botIncoming = input.botIncoming;
    this.closed = input.connectionClosed.then(() => this.close());
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    const results = await Promise.allSettled([
      this.#botIncoming.close(),
      this.#nativeCapabilities.close(),
      this.#closeConnection(),
    ]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  async #closeConnection(): Promise<void> {
    this.#ipc.close();
    await this.#observer.close().catch(() => undefined);
    if (this.#capabilitiesRegistered) {
      await this.#client.unregisterClientCapabilities().catch(() => undefined);
    }
    await this.#client.close();
  }
}

export async function startDesktopRuntimeHostCandidate(
  input: DesktopRuntimeHostCandidateStartInput,
): Promise<DesktopRuntimeHostCandidateStartResult> {
  const connection = await connectOrSpawnRuntimeHost(connectInput(input));
  if (connection.kind !== 'connected') return connection;
  return {
    kind: 'ready',
    candidate: await createDesktopRuntimeHostCandidate(connection.connection, input),
  };
}

export async function createDesktopRuntimeHostCandidate(
  connection: RuntimeHostConnection,
  deps: DesktopRuntimeHostCandidateDeps,
): Promise<DesktopRuntimeHostCandidate> {
  const client = new DesktopRuntimeHostClient(connection);
  const ipc = new ScopedIpcMain(deps.ipcMain);
  let provider: ReturnType<typeof createDesktopNativeCapabilityProvider> | undefined;
  let observer: RuntimeHostSessionObserver | undefined;
  let capabilitiesRegistered = false;
  try {
    const nativeCapabilities = createDesktopNativeCapabilityProvider(deps.nativeCapabilities);
    provider = nativeCapabilities;
    if (
      nativeCapabilities.offers().length > 0 ||
      (nativeCapabilities.services?.().length ?? 0) > 0
    ) {
      await client.replaceClientCapabilities(nativeCapabilities);
      capabilitiesRegistered = true;
    }
    const domains = registerRuntimeHostSessionDomainsIpc(
      {
        client,
        emitModeChanged: deps.emitModeChanged,
        ...(deps.sendToRenderer ? { sendToRenderer: deps.sendToRenderer } : {}),
        ...(deps.onError ? { onError: deps.onError } : {}),
        ...(deps.newId ? { newId: deps.newId } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      },
      ipc,
    );
    observer = new RuntimeHostSessionObserver({
      client,
      emitSessionsChanged: (reason, sessionId, extra) =>
        deps.emitSessionsChanged(reason, sessionId, extra),
      emitSessionDomainChanged: domains.sessionDomainChanged,
      emitAgentGraphChanged: domains.agentGraphChanged,
      ...(deps.now ? { now: deps.now } : {}),
    });
    registerRuntimeHostSessionCatalogIpc(
      {
        client,
        workspaceRoot: deps.workspaceRoot,
        emitSessionsChanged: deps.emitSessionsChanged,
        releaseSessionResources: (sessionId) => nativeCapabilities.releaseSession(sessionId),
        ...(deps.newId ? { newId: deps.newId } : {}),
      },
      ipc,
    );
    registerRuntimeHostSessionExecutionIpc(
      {
        client,
        observer,
        attachmentApprovals: deps.attachmentApprovals,
        emitSessionsChanged: deps.emitSessionsChanged,
        stat: deps.stat,
        resizeImage: deps.resizeImage,
        ...(deps.newId ? { newId: deps.newId } : {}),
      },
      ipc,
    );
    const botIncoming = createBotIncomingMainService({
      botRegistry: deps.botRegistry,
      sessions: createRuntimeHostBotSessionAdapter({
        client,
        resolveCreateTarget: deps.resolveBotCreateTarget,
        emitSessionsChanged: deps.emitSessionsChanged,
        ...(deps.newId ? { newId: deps.newId } : {}),
      }),
    });
    return new DesktopRuntimeHostCandidateImpl({
      client,
      observer,
      ipc,
      botIncoming,
      nativeCapabilities,
      connectionClosed: connection.closed,
      capabilitiesRegistered,
    });
  } catch (error) {
    ipc.close();
    await observer?.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    await Promise.resolve(provider?.close?.()).catch(() => undefined);
    throw error;
  }
}

function connectInput(
  input: DesktopRuntimeHostCandidateStartInput,
): ConnectOrSpawnRuntimeHostInput {
  return {
    rootPath: input.rootPath,
    surface: 'desktop',
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
    ...(input.clientInstanceId === undefined ? {} : { clientInstanceId: input.clientInstanceId }),
    ...(input.electionDeadlineMs === undefined
      ? {}
      : { electionDeadlineMs: input.electionDeadlineMs }),
    ...(input.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: input.connectTimeoutMs }),
    ...(input.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: input.handshakeTimeoutMs }),
  };
}

class ScopedIpcMain implements Pick<IpcMain, 'handle'> {
  readonly #ipcMain: CandidateIpcMain;
  readonly #channels = new Set<string>();
  #closed = false;

  constructor(ipcMain: CandidateIpcMain) {
    this.#ipcMain = ipcMain;
  }

  handle(channel: string, listener: Parameters<IpcMain['handle']>[1]): void {
    if (this.#closed) throw new Error('Desktop Runtime Host candidate IPC is closed');
    if (this.#channels.has(channel)) {
      throw new Error(`Desktop Runtime Host candidate registered duplicate IPC: ${channel}`);
    }
    this.#ipcMain.handle(channel, listener);
    this.#channels.add(channel);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const channel of this.#channels) this.#ipcMain.removeHandler(channel);
    this.#channels.clear();
  }
}
