import { randomUUID } from "node:crypto";
import type { IpcMain } from "electron";
import type { ActiveInteractionRequestEvent } from '@maka/core/events';
import type { CreateSessionRequestInput } from '@maka/core/runtime-inputs';
import type { SessionChangedEvent, SessionChangedReason } from '@maka/core/session';
import type { BotRegistry } from '@maka/runtime/bots';
import {
  connectOrSpawnRuntimeHost,
  connectRemoteRuntimeHostProfile,
  type RuntimeHostSshInteraction,
  type RuntimeHostSshTunnel,
  type RuntimeHostSshTunnelInput,
  type ConnectOrSpawnRuntimeHostInput,
  type ConnectOrSpawnRuntimeHostResult,
  type RuntimeHostConnection,
  type RemoteRuntimeHostProfile,
} from "@maka/runtime-host/client";
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostRegistration,
  type WorkspaceTarget,
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
import type { RuntimeHostTargetIpcMain } from "./runtime-host-reconnecting-ipc-main.js";
import {
  desktopSessionResourceKey,
  requireDesktopTargetScope,
  type DesktopTargetScope,
} from "../shared/runtime-host-identity.js";

type CandidateIpcMain = ReconnectableReadIpcMain & Pick<IpcMain, "removeHandler">;

export interface DesktopRuntimeHostCandidateDeps {
  readonly ipcMain: RuntimeHostTargetIpcMain;
  readonly workspaceRoot: string;
  readonly attachmentApprovals: AttachmentApprovalRegistry;
  readonly stat: (path: string) => Promise<{ size: number }>;
  readonly resizeImage: (bytes: Uint8Array) => Promise<Uint8Array>;
  readonly nativeCapabilities: DesktopNativeCapabilityProviderInput;
  readonly botRegistry: BotRegistry;
  readonly resolveBotCreateTarget: (
    target: DesktopRuntimeHostTargetPolicy,
  ) => Promise<{ readonly workspace: WorkspaceTarget }>;
  readonly resolveSessionCreateProject: (
    input: Pick<CreateSessionRequestInput, "cwd" | "projectId">,
    target: DesktopRuntimeHostTargetPolicy,
  ) => Promise<WorkspaceTarget>;
  readonly emitSessionsChanged: (
    scope: DesktopTargetScope,
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, "connectionSlug" | "modelId" | "turnId">,
  ) => void;
  readonly completeComputerUseTurn: (
    sessionId: string,
  ) => void | Promise<void>;
  readonly e2eInteractions?: RuntimeHostSessionExecutionIpcDeps["e2eInteractions"];
  readonly renderer?: {
    send(channel: string, scope: DesktopTargetScope, payload: unknown): void;
  };
  readonly onError?: RuntimeHostSessionDomainsIpcDeps["onError"];
  readonly isTargetActive?: () => boolean;
  readonly isTargetValid?: () => boolean;
  readonly newId?: () => string;
  readonly now?: () => number;
  readonly openSshTunnel?: (
    input: RuntimeHostSshTunnelInput,
  ) => Promise<RuntimeHostSshTunnel>;
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
    target: DesktopRuntimeHostTargetPolicy,
    scope: DesktopTargetScope,
    isTargetActive: () => boolean,
  ) => void | (() => void | Promise<void>);
}

export type DesktopRuntimeHostTargetPolicy =
  | { readonly kind: "local"; readonly rootId: string }
  | {
      readonly kind: "remote";
      readonly rootId: string;
    };

export interface DesktopRuntimeHostCandidateControls {
  refreshClientCapabilities(): Promise<void>;
}

export interface DesktopRuntimeHostCandidateStartInput
  extends Omit<DesktopRuntimeHostCandidateDeps, "ipcMain"> {
  readonly ipcMain: CandidateIpcMain;
  readonly rootPath: string;
  readonly clientInstanceId?: string;
  readonly electionDeadlineMs?: number;
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly candidateEntrypoint: string | URL;
  readonly desktopE2e?: boolean;
  readonly generation?: string;
  readonly takeoverHostEpoch?: string;
  readonly signal?: AbortSignal;
  readonly remote?: {
    readonly profile: RemoteRuntimeHostProfile;
    readonly credential: string;
    readonly sshInteraction?: RuntimeHostSshInteraction;
  };
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
  readonly hostLifecycleMode: HostRegistration["lifecycleMode"] | "remote";
  stopSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

class DesktopRuntimeHostCandidateImpl implements DesktopRuntimeHostCandidate {
  readonly botIncoming: BotIncomingMainService;
  readonly client: DesktopRuntimeHostClient;
  readonly closed: Promise<void>;
  readonly hostLifecycleMode: HostRegistration["lifecycleMode"] | "remote";
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
    hostLifecycleMode: HostRegistration["lifecycleMode"] | "remote";
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
    this.hostLifecycleMode = input.hostLifecycleMode;
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
  const ipcMain = requireTargetIpcMain(input.ipcMain);
  if (input.remote) {
    return startRemoteDesktopRuntimeHostCandidate(
      input,
      input.remote,
      observationRegistry,
      ipcMain,
    );
  }
  const connection = await connectOrSpawnRuntimeHost(connectInput(input));
  if (connection.kind !== "connected") return connection;
  try {
    return {
      kind: "ready",
      candidate: await createDesktopRuntimeHostCandidate(
        connection.connection,
        { ...input, ipcMain },
        observationRegistry,
        connection.registration.lifecycleMode,
        "local",
      ),
    };
  } catch (error) {
    await connection.connection.close().catch(() => undefined);
    throw error;
  }
}

async function startRemoteDesktopRuntimeHostCandidate(
  input: DesktopRuntimeHostCandidateStartInput,
  remote: NonNullable<DesktopRuntimeHostCandidateStartInput["remote"]>,
  observationRegistry: RuntimeHostSessionObservationRegistry | undefined,
  ipcMain: RuntimeHostTargetIpcMain,
): Promise<DesktopRuntimeHostCandidateStartResult> {
  const connection = await connectRemoteRuntimeHostProfile({
    profile: remote.profile,
    credential: remote.credential,
    surface: "desktop",
    clientInstanceId: input.clientInstanceId ?? randomUUID(),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: input.connectTimeoutMs }),
    ...(input.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: input.handshakeTimeoutMs }),
    readyTimeoutMs: input.electionDeadlineMs ?? 45_000,
    ...(remote.sshInteraction === undefined
      ? {}
      : { sshInteraction: remote.sshInteraction }),
  },
  {
    ...(input.openSshTunnel ? { openSshTunnel: input.openSshTunnel } : {}),
  });
  try {
    return {
      kind: "ready",
      candidate: await createDesktopRuntimeHostCandidate(
        connection,
        { ...input, ipcMain },
        observationRegistry,
        "remote",
        "remote",
      ),
    };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

export async function createDesktopRuntimeHostCandidate(
  connection: RuntimeHostConnection,
  deps: DesktopRuntimeHostCandidateDeps,
  observationRegistry: RuntimeHostSessionObservationRegistry | undefined,
  hostLifecycleMode: HostRegistration["lifecycleMode"] | "remote",
  targetKind: DesktopRuntimeHostTargetPolicy["kind"],
): Promise<DesktopRuntimeHostCandidate> {
  const target: DesktopRuntimeHostTargetPolicy = {
    kind: targetKind,
    rootId: connection.rootId,
  };
  const ipcMain = deps.ipcMain;
  const scope = { hostId: connection.rootId, targetEpoch: ipcMain.epoch };
  const client = new DesktopRuntimeHostClient(connection);
  const ipc = new ScopedIpcMain(ipcMain, scope);
  const isTargetActive = deps.isTargetActive ?? (() => true);
  const emitSessionsChanged = (
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, "connectionSlug" | "modelId" | "turnId">,
  ): void => {
    if (isTargetActive()) deps.emitSessionsChanged(scope, reason, sessionId, extra);
  };
  const emitModeChanged = (sessionId: string): void =>
    emitSessionsChanged("mode-change", sessionId);
  const sendToRenderer: RuntimeHostSessionDomainsIpcDeps["sendToRenderer"] = (
    channel,
    payload,
  ) => {
    if (isTargetActive()) deps.renderer?.send(channel, scope, payload);
  };
  const reportError = (error: unknown): void => {
    if (isTargetActive()) deps.onError?.(error);
  };
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
          deps.nativeCapabilities.releaseBrowserSession(
            desktopSessionResourceKey({ ...scope, sessionId }),
          ),
        ),
        Promise.resolve().then(() =>
          deps.nativeCapabilities.releaseComputerUseSession(
            desktopSessionResourceKey({ ...scope, sessionId }),
          ),
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
      sendToRenderer?.('sessions:active-interactions-changed', {
        sessionId,
        interactions,
      });
    };
    const sessionObserver = new RuntimeHostSessionObserver({
      client,
      emitSessionsChanged: (reason, sessionId, extra) =>
        emitSessionsChanged(reason, sessionId, extra),
      emitSessionDomainChanged: (change) => domains?.sessionDomainChanged(change),
      emitRuntimeResourcePtyData: (event) => domains?.runtimeResourcePtyData(event),
      emitAgentGraphChanged: (event) => domains?.agentGraphChanged(event),
      emitActiveInteractionsChanged,
      emitSubscriptionRecovered: (sessionId) =>
        domains?.sessionSubscriptionRecovered(sessionId),
      emitObservationSeed: (sessionId, phase) =>
        sendToRenderer?.('sessions:observation-seed', { sessionId, phase }),
      onWatchedTurnFinished: (sessionId, outcome) =>
        outcome === "completed"
          ? deps.completeComputerUseTurn(
              desktopSessionResourceKey({ ...scope, sessionId }),
            )
          : deps.nativeCapabilities.releaseComputerUseSession(
              desktopSessionResourceKey({ ...scope, sessionId }),
            ),
      recoverConnectionClosed: observationRegistry !== undefined,
      ...(deps.now ? { now: deps.now } : {}),
    });
    observer = sessionObserver;
    domains = registerRuntimeHostSessionDomainsIpc(
      {
        client,
        sessionObserver,
        emitModeChanged,
        ...(deps.renderer ? { sendToRenderer } : {}),
        ...(deps.onError ? { onError: reportError } : {}),
        ...(deps.newId ? { newId: deps.newId } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      },
      ipc,
    );
    closeSessionDomains = domains.close;
    const observedSessionIds = sessionObservations.observedSessionIds();
    for (const sessionId of observedSessionIds) {
      sendToRenderer('sessions:observation-seed', { sessionId, phase: 'pending' });
    }
    observationsAttached = true;
    const restoredSessionIds = await sessionObservations.attach(
      sessionObserver,
      (target) => ({
        id: target.id,
        send: (channel, payload) =>
          (target.send as (channel: string, ...args: unknown[]) => void)(
            channel,
            scope,
            payload,
          ),
        once: target.once.bind(target),
        off: target.off.bind(target),
      }),
    );
    const restoredSessionIdSet = new Set(restoredSessionIds);
    const failedSessionIds = observedSessionIds.filter(
      (sessionId) => !restoredSessionIdSet.has(sessionId),
    );
    if (failedSessionIds.length > 0) {
      throw new Error(
        `Failed to restore Session observations: ${failedSessionIds.join(', ')}`,
      );
    }
    for (const sessionId of restoredSessionIds) {
      sendToRenderer('sessions:observation-seed', { sessionId, phase: 'ready' });
      emitSessionsChanged("message-appended", sessionId);
      emitSessionsChanged("goal-change", sessionId);
      domains.sessionSubscriptionRecovered(sessionId);
      emitActiveInteractionsChanged(
        sessionId,
        sessionObserver.listActiveInteractions(sessionId) ?? [],
      );
    }
    const watchComputerUseTurn = (sessionId: string, turnId: string): void => {
      void sessionObserver
        .watchTurn(sessionId, turnId)
        .catch(reportError);
    };
    const createNativeProvider = (): DesktopNativeCapabilityProvider => {
      let provider: DesktopNativeCapabilityProvider;
      provider = createDesktopNativeCapabilityProvider(
        deps.nativeCapabilities,
        {
          hostPathAccess: target.kind === "local" ? "cwd" : "none",
          ...(target.kind === "remote" ? { clientCwd: deps.workspaceRoot } : {}),
          releaseResourcesOnClose: false,
          targetScope: scope,
          nativeSessionId: (sessionId) =>
            desktopSessionResourceKey({ ...scope, sessionId }),
          onSessionUsed: (sessionId) => nativeSessionIds.add(sessionId),
          onComputerUseTurnUsed: watchComputerUseTurn,
          isTargetValid: deps.isTargetValid,
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
        await releaseNativeSession(sessionId).catch(reportError);
        emitSessionsChanged("deleted", sessionId);
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
    const registeredClientIpc = deps.registerClientIpc?.(
      client,
      ipc,
      { refreshClientCapabilities },
      target,
      scope,
      isTargetActive,
    );
    disposeClientIpc =
      typeof registeredClientIpc === "function"
        ? registeredClientIpc
        : undefined;
    registerRuntimeHostSessionCatalogIpc(
      {
        client,
        runningTurnIds: (sessionId) => sessionObserver.observedRunningTurnIds(sessionId),
        resolveCreateProject: (input) => deps.resolveSessionCreateProject(input, target),
        emitSessionsChanged,
        releaseSessionResources: releaseNativeSession,
        sessionCopyCleanup,
        ...(deps.newId ? { newId: deps.newId } : {}),
      },
      ipc,
    );
    registerRuntimeHostExternalSessionsIpc(
      {
        client,
        emitSessionsChanged,
      },
      ipc,
    );
    const stopSession = registerRuntimeHostSessionExecutionIpc(
      {
        client,
        observer: sessionObserver,
        observations: sessionObservations,
        attachmentApprovals: deps.attachmentApprovals,
        emitSessionsChanged,
        stat: deps.stat,
        resizeImage: deps.resizeImage,
        beforeStop: (sessionId) =>
          deps.nativeCapabilities.releaseComputerUseSession(
            desktopSessionResourceKey({ ...scope, sessionId }),
          ),
        sessionCopyCleanup,
        onBackgroundError: reportError,
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
        resolveCreateTarget: () => deps.resolveBotCreateTarget(target),
        emitSessionsChanged,
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
      hostLifecycleMode,
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
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    ...(input.takeoverHostEpoch === undefined
      ? {}
      : { takeoverHostEpoch: input.takeoverHostEpoch }),
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
    ...(input.desktopE2e ? { desktopE2e: true } : {}),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function requireTargetIpcMain(ipcMain: CandidateIpcMain): RuntimeHostTargetIpcMain {
  const target = ipcMain as Partial<RuntimeHostTargetIpcMain>;
  if (
    typeof target.epoch !== "string" ||
    !target.epoch ||
    typeof target.isActive !== "function"
  ) {
    throw new Error("Desktop Runtime Host target IPC is required");
  }
  return ipcMain as RuntimeHostTargetIpcMain;
}

class ScopedIpcMain implements ReconnectableReadIpcMain {
  readonly #ipcMain: CandidateIpcMain;
  readonly #channels = new Set<string>();
  #closed = false;

  constructor(
    ipcMain: CandidateIpcMain,
    private readonly scope: DesktopTargetScope,
  ) {
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
    const hostScopedListener: IpcHandler = (event, scope, ...args) => {
      requireDesktopTargetScope(scope, this.scope);
      return listener(event, ...args);
    };
    if (reconnectableRead && this.#ipcMain.handleReconnectableRead) {
      this.#ipcMain.handleReconnectableRead(channel, hostScopedListener);
    } else {
      this.#ipcMain.handle(channel, hostScopedListener);
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
