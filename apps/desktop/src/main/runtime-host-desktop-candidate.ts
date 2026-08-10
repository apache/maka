import type { IpcMain } from "electron";
import type {
  ActiveInteractionRequestEvent,
  CreateSessionRequestInput,
  SessionChangedEvent,
  SessionChangedReason,
} from "@maka/core";
import type { BotRegistry } from "@maka/runtime";
import {
  connectOrSpawnRuntimeHost,
  waitForRuntimeHostReady,
  type ConnectOrSpawnRuntimeHostInput,
  type ConnectOrSpawnRuntimeHostResult,
  type RuntimeHostConnection,
} from "@maka/runtime-host/client";
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from "@maka/runtime-host/protocol";
import type { AttachmentApprovalRegistry } from "./attachment-approval.js";
import {
  createBotIncomingMainService,
  type BotIncomingMainService,
} from "./bot-incoming-main.js";
import { createRuntimeHostBotSessionAdapter } from "./runtime-host-bot-session-adapter.js";
import { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import type {
  SessionCopyCleanupAuthority,
  SessionCopyCleanupDisposition,
} from "./quote-companion-cleanup.js";
import {
  createDesktopNativeCapabilityProvider,
  type DesktopNativeCapabilityProvider,
  type DesktopNativeCapabilityProviderInput,
} from "./runtime-host-native-capabilities.js";
import { registerRuntimeHostSessionCatalogIpc } from "./runtime-host-session-catalog-ipc-main.js";
import { registerRuntimeHostExternalSessionsIpc } from "./runtime-host-external-sessions-ipc-main.js";
import {
  registerRuntimeHostSessionDomainsIpc,
  type RuntimeHostSessionDomainsIpcDeps,
  type RuntimeHostSessionDomainsIpcHandle,
} from "./runtime-host-session-domains-ipc-main.js";
import {
  registerRuntimeHostSessionExecutionIpc,
  type RuntimeHostSessionExecutionIpcDeps,
} from "./runtime-host-session-execution-ipc-main.js";
import { RuntimeHostSessionObservationRegistry } from "./runtime-host-session-observation-registry.js";
import { RuntimeHostSessionObserver } from "./runtime-host-session-observer.js";
import type { IpcHandler, ReconnectableReadIpcMain } from "./ipc-reconnect-policy.js";

type CandidateIpcMain = ReconnectableReadIpcMain & Pick<IpcMain, "removeHandler">;

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
  readonly resolveSessionCreateProject: (
    input: Pick<CreateSessionRequestInput, "cwd" | "projectId">,
  ) => Promise<{ readonly cwd: string; readonly projectId?: string | null }>;
  readonly emitSessionsChanged: (
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, "connectionSlug" | "modelId" | "turnId">,
  ) => void;
  readonly emitModeChanged: RuntimeHostSessionDomainsIpcDeps["emitModeChanged"];
  readonly completeComputerUseTurn: (
    sessionId: string,
  ) => void | Promise<void>;
  readonly e2eInteractions?: RuntimeHostSessionExecutionIpcDeps["e2eInteractions"];
  readonly sendToRenderer?: RuntimeHostSessionDomainsIpcDeps["sendToRenderer"];
  readonly onError?: RuntimeHostSessionDomainsIpcDeps["onError"];
  readonly newId?: () => string;
  readonly now?: () => number;
  readonly createSessionCopyCleanup: (input: {
    removeSession: (sessionId: string) => Promise<SessionCopyCleanupDisposition>;
    resumeSessionCopy: (input: {
      sessionId: string;
      kind: 'branch' | 'revision';
      sourceSessionId: string;
      sourceTurnId: string;
    }) => Promise<void>;
  }) => SessionCopyCleanupAuthority;
  readonly registerClientIpc?: (
    client: DesktopRuntimeHostClient,
    ipcMain: ReconnectableReadIpcMain,
    controls: DesktopRuntimeHostCandidateControls,
  ) => void | (() => void | Promise<void>);
}

export interface DesktopRuntimeHostCandidateControls {
  refreshClientCapabilities(): Promise<void>;
}

export interface DesktopRuntimeHostCandidateStartInput extends DesktopRuntimeHostCandidateDeps {
  readonly rootPath: string;
  readonly clientInstanceId?: string;
  readonly electionDeadlineMs?: number;
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly candidateEntrypoint: string | URL;
  readonly signal?: AbortSignal;
}

export type DesktopRuntimeHostCandidateStartResult =
  | {
      readonly kind: "ready";
      readonly candidate: DesktopRuntimeHostCandidate;
    }
  | Exclude<ConnectOrSpawnRuntimeHostResult, { kind: "connected" }>;

export interface DesktopRuntimeHostCandidate {
  readonly botIncoming: BotIncomingMainService;
  readonly client: DesktopRuntimeHostClient;
  readonly closed: Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

class DesktopRuntimeHostCandidateImpl implements DesktopRuntimeHostCandidate {
  readonly botIncoming: BotIncomingMainService;
  readonly client: DesktopRuntimeHostClient;
  readonly closed: Promise<void>;
  readonly #client: DesktopRuntimeHostClient;
  readonly #observer: RuntimeHostSessionObserver;
  readonly #ipc: ScopedIpcMain;
  readonly #botIncoming: BotIncomingMainService;
  readonly #closeNativeCapabilities: () => Promise<void>;
  readonly #closeSessionDomains: () => Promise<void>;
  readonly #disposeClientIpc: (() => void | Promise<void>) | undefined;
  readonly #detachSessionObservations: () => void;
  readonly #closeSessionObservations: () => Promise<void>;
  readonly #hasRegisteredCapabilities: () => boolean;
  readonly #stopSession: (sessionId: string) => Promise<void>;
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    client: DesktopRuntimeHostClient;
    observer: RuntimeHostSessionObserver;
    ipc: ScopedIpcMain;
    botIncoming: BotIncomingMainService;
    closeNativeCapabilities: () => Promise<void>;
    closeSessionDomains: () => Promise<void>;
    disposeClientIpc: (() => void | Promise<void>) | undefined;
    detachSessionObservations: () => void;
    closeSessionObservations: () => Promise<void>;
    connectionClosed: Promise<void>;
    hasRegisteredCapabilities: () => boolean;
    stopSession: (sessionId: string) => Promise<void>;
  }) {
    this.#client = input.client;
    this.client = input.client;
    this.#observer = input.observer;
    this.#ipc = input.ipc;
    this.#botIncoming = input.botIncoming;
    this.#closeNativeCapabilities = input.closeNativeCapabilities;
    this.#closeSessionDomains = input.closeSessionDomains;
    this.#disposeClientIpc = input.disposeClientIpc;
    this.#detachSessionObservations = input.detachSessionObservations;
    this.#closeSessionObservations = input.closeSessionObservations;
    this.#hasRegisteredCapabilities = input.hasRegisteredCapabilities;
    this.#stopSession = input.stopSession;
    this.botIncoming = input.botIncoming;
    this.closed = input.connectionClosed.then(() => this.close());
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  stopSession(sessionId: string): Promise<void> {
    return this.#stopSession(sessionId);
  }

  async #close(): Promise<void> {
    this.#ipc.close();
    this.#detachSessionObservations();
    const domainResults = await Promise.allSettled([this.#closeSessionDomains()]);
    const results = await Promise.allSettled([
      this.#botIncoming.close(),
      this.#closeNativeCapabilities(),
      Promise.resolve().then(() => this.#disposeClientIpc?.()),
      this.#closeConnection(),
    ]);
    const failed = [...domainResults, ...results].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  }

  async #closeConnection(): Promise<void> {
    await this.#observer.close().catch(() => undefined);
    await this.#closeSessionObservations().catch(() => undefined);
    if (this.#hasRegisteredCapabilities()) {
      await this.#client.unregisterClientCapabilities().catch(() => undefined);
    }
    await this.#client.close();
  }
}

export async function startDesktopRuntimeHostCandidate(
  input: DesktopRuntimeHostCandidateStartInput,
  observationRegistry?: RuntimeHostSessionObservationRegistry,
): Promise<DesktopRuntimeHostCandidateStartResult> {
  const connection = await connectOrSpawnRuntimeHost(connectInput(input));
  if (connection.kind !== "connected") return connection;
  try {
    await waitForRuntimeHostReady(
      connection.connection,
      input.electionDeadlineMs ?? 45_000,
      input.signal,
    );
    return {
      kind: "ready",
      candidate: await createDesktopRuntimeHostCandidate(
        connection.connection,
        input,
        observationRegistry,
      ),
    };
  } catch (error) {
    await connection.connection.close().catch(() => undefined);
    throw error;
  }
}

export async function createDesktopRuntimeHostCandidate(
  connection: RuntimeHostConnection,
  deps: DesktopRuntimeHostCandidateDeps,
  observationRegistry?: RuntimeHostSessionObservationRegistry,
): Promise<DesktopRuntimeHostCandidate> {
  const client = new DesktopRuntimeHostClient(connection);
  const ipc = new ScopedIpcMain(deps.ipcMain);
  const sessionObservations =
    observationRegistry ??
    new RuntimeHostSessionObservationRegistry((error) => deps.onError?.(error));
  const ownsSessionObservations = observationRegistry === undefined;
  const providers = new Set<DesktopNativeCapabilityProvider>();
  const nativeSessionIds = new Set<string>();
  const releaseNativeResources = async (
    sessionIds: readonly string[],
  ): Promise<void> => {
    const results = await Promise.allSettled(
      sessionIds.flatMap((sessionId) => [
        Promise.resolve().then(() =>
          deps.nativeCapabilities.releaseBrowserSession(sessionId),
        ),
        Promise.resolve().then(() =>
          deps.nativeCapabilities.releaseComputerUseSession(sessionId),
        ),
      ]),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  };
  const releaseNativeSession = async (sessionId: string): Promise<void> => {
    const abortResults = await Promise.allSettled(
      [...providers].map((provider) => provider.abortSession(sessionId)),
    );
    const releaseResult = await Promise.allSettled([
      releaseNativeResources([sessionId]),
    ]);
    nativeSessionIds.delete(sessionId);
    const failed = [...abortResults, ...releaseResult].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  };
  const closeNativeCapabilities = async (): Promise<void> => {
    const results = await Promise.allSettled(
      [...providers].map((provider) => provider.close()),
    );
    providers.clear();
    const releaseResults = await Promise.allSettled([
      releaseNativeResources([...nativeSessionIds]),
    ]);
    nativeSessionIds.clear();
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    ) ??
      releaseResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
    if (failed) throw failed.reason;
  };
  let observer: RuntimeHostSessionObserver | undefined;
  let closeSessionDomains: (() => Promise<void>) | undefined;
  let disposeClientIpc: (() => void | Promise<void>) | undefined;
  let observationsAttached = false;
  let capabilitiesRegistered = false;
  try {
    let domains: RuntimeHostSessionDomainsIpcHandle | undefined;
    const emitActiveInteractionsChanged = (
      sessionId: string,
      interactions: readonly ActiveInteractionRequestEvent[],
    ): void => {
      deps.sendToRenderer?.('sessions:active-interactions-changed', {
        sessionId,
        interactions,
      });
    };
    const sessionObserver = new RuntimeHostSessionObserver({
      client,
      emitSessionsChanged: (reason, sessionId, extra) =>
        deps.emitSessionsChanged(reason, sessionId, extra),
      emitSessionDomainChanged: (change) => domains?.sessionDomainChanged(change),
      emitRuntimeResourcePtyData: (event) => domains?.runtimeResourcePtyData(event),
      emitAgentGraphChanged: (event) => domains?.agentGraphChanged(event),
      emitActiveInteractionsChanged,
      emitSubscriptionRecovered: (sessionId) =>
        domains?.sessionSubscriptionRecovered(sessionId),
      onWatchedTurnFinished: (sessionId, outcome) =>
        outcome === "completed"
          ? deps.completeComputerUseTurn(sessionId)
          : deps.nativeCapabilities.releaseComputerUseSession(sessionId),
      recoverConnectionClosed: observationRegistry !== undefined,
      ...(deps.now ? { now: deps.now } : {}),
    });
    observer = sessionObserver;
    domains = registerRuntimeHostSessionDomainsIpc(
      {
        client,
        sessionObserver,
        emitModeChanged: deps.emitModeChanged,
        ...(deps.sendToRenderer ? { sendToRenderer: deps.sendToRenderer } : {}),
        ...(deps.onError ? { onError: deps.onError } : {}),
        ...(deps.newId ? { newId: deps.newId } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      },
      ipc,
    );
    closeSessionDomains = domains.close;
    const restoredSessionIds = await sessionObservations.attach(sessionObserver);
    observationsAttached = true;
    for (const sessionId of restoredSessionIds) {
      deps.emitSessionsChanged("message-appended", sessionId);
      deps.emitSessionsChanged("goal-change", sessionId);
      domains.sessionSubscriptionRecovered(sessionId);
      emitActiveInteractionsChanged(
        sessionId,
        sessionObserver.listActiveInteractions(sessionId) ?? [],
      );
    }
    const watchComputerUseTurn = (sessionId: string, turnId: string): void => {
      void sessionObserver
        .watchTurn(sessionId, turnId)
        .catch((error) => deps.onError?.(error));
    };
    const createNativeProvider = (): DesktopNativeCapabilityProvider => {
      let provider: DesktopNativeCapabilityProvider;
      provider = createDesktopNativeCapabilityProvider(
        deps.nativeCapabilities,
        {
          releaseResourcesOnClose: false,
          onSessionUsed: (sessionId) => nativeSessionIds.add(sessionId),
          onComputerUseTurnUsed: watchComputerUseTurn,
          onClosed: () => providers.delete(provider),
        },
      );
      providers.add(provider);
      return provider;
    };
    const nativeCapabilities = createNativeProvider();
    if (
      nativeCapabilities.offers().length > 0 ||
      (nativeCapabilities.services?.().length ?? 0) > 0
    ) {
      await client.replaceClientCapabilities(nativeCapabilities);
      capabilitiesRegistered = true;
    }
    let capabilityRefresh = Promise.resolve();
    const refreshClientCapabilities = (): Promise<void> => {
      capabilityRefresh = capabilityRefresh
        .catch(() => undefined)
        .then(async () => {
          const replacement = createNativeProvider();
          try {
            await client.replaceClientCapabilities(replacement);
            capabilitiesRegistered = true;
          } catch (error) {
            await replacement.close().catch(() => undefined);
            throw error;
          }
        });
      return capabilityRefresh;
    };
    const sessionCopyCleanup = deps.createSessionCopyCleanup({
      removeSession: async (sessionId) => {
        const disposition = await client.removeSessionCopy(sessionId);
        if (disposition === "retained") return disposition;
        await releaseNativeSession(sessionId).catch((error) => deps.onError?.(error));
        deps.emitSessionsChanged("deleted", sessionId);
        return disposition;
      },
      resumeSessionCopy: async ({ sessionId, kind, sourceSessionId, sourceTurnId }) => {
        await client.copySession(kind, {
          sourceSessionId,
          targetSessionId: sessionId,
          sourceTurnId,
        });
      },
    });
    const registeredClientIpc = deps.registerClientIpc?.(client, ipc, {
      refreshClientCapabilities,
    });
    disposeClientIpc =
      typeof registeredClientIpc === "function"
        ? registeredClientIpc
        : undefined;
    registerRuntimeHostSessionCatalogIpc(
      {
        client,
        resolveCreateProject: deps.resolveSessionCreateProject,
        emitSessionsChanged: deps.emitSessionsChanged,
        releaseSessionResources: releaseNativeSession,
        sessionCopyCleanup,
        ...(deps.newId ? { newId: deps.newId } : {}),
      },
      ipc,
    );
    registerRuntimeHostExternalSessionsIpc(
      {
        client,
        emitSessionsChanged: deps.emitSessionsChanged,
      },
      ipc,
    );
    const stopSession = registerRuntimeHostSessionExecutionIpc(
      {
        client,
        observer: sessionObserver,
        observations: sessionObservations,
        attachmentApprovals: deps.attachmentApprovals,
        emitSessionsChanged: deps.emitSessionsChanged,
        stat: deps.stat,
        resizeImage: deps.resizeImage,
        beforeStop: deps.nativeCapabilities.releaseComputerUseSession,
        sessionCopyCleanup,
        onBackgroundError: (error) => deps.onError?.(error),
        ...(deps.e2eInteractions
          ? { e2eInteractions: deps.e2eInteractions }
          : {}),
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
      observer: sessionObserver,
      ipc,
      botIncoming,
      closeNativeCapabilities,
      closeSessionDomains: domains.close,
      disposeClientIpc,
      detachSessionObservations: () =>
        sessionObservations.detach(sessionObserver),
      closeSessionObservations: () =>
        ownsSessionObservations
          ? sessionObservations.close()
          : Promise.resolve(),
      connectionClosed: connection.closed,
      hasRegisteredCapabilities: () => capabilitiesRegistered,
      stopSession,
    });
  } catch (error) {
    ipc.close();
    if (observationsAttached && observer) sessionObservations.detach(observer);
    await Promise.resolve(disposeClientIpc?.()).catch(() => undefined);
    await closeSessionDomains?.().catch(() => undefined);
    await observer?.close().catch(() => undefined);
    if (ownsSessionObservations) {
      await sessionObservations.close().catch(() => undefined);
    }
    await client.close().catch(() => undefined);
    await closeNativeCapabilities().catch(() => undefined);
    throw error;
  }
}

function connectInput(
  input: DesktopRuntimeHostCandidateStartInput,
): ConnectOrSpawnRuntimeHostInput {
  return {
    rootPath: input.rootPath,
    surface: "desktop",
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    candidateEntrypoint: input.candidateEntrypoint,
    ...(input.clientInstanceId === undefined
      ? {}
      : { clientInstanceId: input.clientInstanceId }),
    ...(input.electionDeadlineMs === undefined
      ? {}
      : { electionDeadlineMs: input.electionDeadlineMs }),
    ...(input.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: input.connectTimeoutMs }),
    ...(input.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: input.handshakeTimeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

class ScopedIpcMain implements ReconnectableReadIpcMain {
  readonly #ipcMain: CandidateIpcMain;
  readonly #channels = new Set<string>();
  #closed = false;

  constructor(ipcMain: CandidateIpcMain) {
    this.#ipcMain = ipcMain;
  }

  handle(channel: string, listener: Parameters<IpcMain["handle"]>[1]): void {
    this.#handle(channel, listener, false);
  }

  handleReconnectableRead(channel: string, listener: IpcHandler): void {
    this.#handle(channel, listener, true);
  }

  #handle(channel: string, listener: IpcHandler, reconnectableRead: boolean): void {
    if (this.#closed)
      throw new Error("Desktop Runtime Host candidate IPC is closed");
    if (this.#channels.has(channel)) {
      throw new Error(
        `Desktop Runtime Host candidate registered duplicate IPC: ${channel}`,
      );
    }
    if (reconnectableRead && this.#ipcMain.handleReconnectableRead) {
      this.#ipcMain.handleReconnectableRead(channel, listener);
    } else {
      this.#ipcMain.handle(channel, listener);
    }
    this.#channels.add(channel);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const channel of this.#channels) this.#ipcMain.removeHandler(channel);
    this.#channels.clear();
  }
}
