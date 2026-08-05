import type { IpcMain } from "electron";
import type { SessionChangedEvent, SessionChangedReason } from "@maka/core";
import type { BotRegistry } from "@maka/runtime";
import {
  connectOrSpawnRuntimeHost,
  type ConnectOrSpawnRuntimeHostInput,
  type ConnectOrSpawnRuntimeHostResult,
  type RuntimeHostConnection,
} from "@maka/runtime-host/client";
import { RUNTIME_HOST_PROTOCOL_VERSION } from "@maka/runtime-host/protocol";
import type { AttachmentApprovalRegistry } from "./attachment-approval.js";
import {
  createBotIncomingMainService,
  type BotIncomingMainService,
} from "./bot-incoming-main.js";
import { createRuntimeHostBotSessionAdapter } from "./runtime-host-bot-session-adapter.js";
import { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import {
  createDesktopNativeCapabilityProvider,
  type DesktopNativeCapabilityProvider,
  type DesktopNativeCapabilityProviderInput,
} from "./runtime-host-native-capabilities.js";
import { registerRuntimeHostSessionCatalogIpc } from "./runtime-host-session-catalog-ipc-main.js";
import {
  registerRuntimeHostSessionDomainsIpc,
  type RuntimeHostSessionDomainsIpcDeps,
} from "./runtime-host-session-domains-ipc-main.js";
import { registerRuntimeHostSessionExecutionIpc } from "./runtime-host-session-execution-ipc-main.js";
import { RuntimeHostSessionObserver } from "./runtime-host-session-observer.js";

type CandidateIpcMain = Pick<IpcMain, "handle" | "removeHandler">;

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
    extra?: Pick<SessionChangedEvent, "connectionSlug" | "modelId" | "turnId">,
  ) => void;
  readonly emitModeChanged: RuntimeHostSessionDomainsIpcDeps["emitModeChanged"];
  readonly sendToRenderer?: RuntimeHostSessionDomainsIpcDeps["sendToRenderer"];
  readonly onError?: RuntimeHostSessionDomainsIpcDeps["onError"];
  readonly newId?: () => string;
  readonly now?: () => number;
  readonly registerClientIpc?: (
    client: DesktopRuntimeHostClient,
    ipcMain: Pick<IpcMain, "handle">,
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
  readonly candidateEntrypoint?: string | URL;
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
  readonly #disposeClientIpc: (() => void | Promise<void>) | undefined;
  readonly #hasRegisteredCapabilities: () => boolean;
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    client: DesktopRuntimeHostClient;
    observer: RuntimeHostSessionObserver;
    ipc: ScopedIpcMain;
    botIncoming: BotIncomingMainService;
    closeNativeCapabilities: () => Promise<void>;
    disposeClientIpc: (() => void | Promise<void>) | undefined;
    connectionClosed: Promise<void>;
    hasRegisteredCapabilities: () => boolean;
  }) {
    this.#client = input.client;
    this.client = input.client;
    this.#observer = input.observer;
    this.#ipc = input.ipc;
    this.#botIncoming = input.botIncoming;
    this.#closeNativeCapabilities = input.closeNativeCapabilities;
    this.#disposeClientIpc = input.disposeClientIpc;
    this.#hasRegisteredCapabilities = input.hasRegisteredCapabilities;
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
      this.#closeNativeCapabilities(),
      Promise.resolve().then(() => this.#disposeClientIpc?.()),
      this.#closeConnection(),
    ]);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  }

  async #closeConnection(): Promise<void> {
    this.#ipc.close();
    await this.#observer.close().catch(() => undefined);
    if (this.#hasRegisteredCapabilities()) {
      await this.#client.unregisterClientCapabilities().catch(() => undefined);
    }
    await this.#client.close();
  }
}

export async function startDesktopRuntimeHostCandidate(
  input: DesktopRuntimeHostCandidateStartInput,
): Promise<DesktopRuntimeHostCandidateStartResult> {
  const connection = await connectOrSpawnRuntimeHost(connectInput(input));
  if (connection.kind !== "connected") return connection;
  try {
    await waitForRuntimeHostReady(
      connection.connection,
      input.electionDeadlineMs ?? 45_000,
    );
    return {
      kind: "ready",
      candidate: await createDesktopRuntimeHostCandidate(
        connection.connection,
        input,
      ),
    };
  } catch (error) {
    await connection.connection.close().catch(() => undefined);
    throw error;
  }
}

async function waitForRuntimeHostReady(
  connection: RuntimeHostConnection,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await connection.status(Math.max(1, deadline - Date.now()));
    if (status.state === "ready") return;
    if (status.state === "draining")
      throw new Error("Runtime Host drained before becoming ready");
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error("Runtime Host did not become ready before the deadline");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, remaining)),
    );
  }
}

export async function createDesktopRuntimeHostCandidate(
  connection: RuntimeHostConnection,
  deps: DesktopRuntimeHostCandidateDeps,
): Promise<DesktopRuntimeHostCandidate> {
  const client = new DesktopRuntimeHostClient(connection);
  const ipc = new ScopedIpcMain(deps.ipcMain);
  const providers = new Set<DesktopNativeCapabilityProvider>();
  const nativeSessionIds = new Set<string>();
  const createNativeProvider = (): DesktopNativeCapabilityProvider => {
    let provider: DesktopNativeCapabilityProvider;
    provider = createDesktopNativeCapabilityProvider(
      deps.nativeCapabilities,
      {
        releaseResourcesOnClose: false,
        onSessionUsed: (sessionId) => nativeSessionIds.add(sessionId),
        onClosed: () => providers.delete(provider),
      },
    );
    providers.add(provider);
    return provider;
  };
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
  let disposeClientIpc: (() => void | Promise<void>) | undefined;
  let capabilitiesRegistered = false;
  try {
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
        releaseSessionResources: releaseNativeSession,
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
    const registeredClientIpc = deps.registerClientIpc?.(client, ipc, {
      refreshClientCapabilities,
    });
    disposeClientIpc =
      typeof registeredClientIpc === "function"
        ? registeredClientIpc
        : undefined;
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
      closeNativeCapabilities,
      disposeClientIpc,
      connectionClosed: connection.closed,
      hasRegisteredCapabilities: () => capabilitiesRegistered,
    });
  } catch (error) {
    ipc.close();
    await Promise.resolve(disposeClientIpc?.()).catch(() => undefined);
    await observer?.close().catch(() => undefined);
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
    ...(input.candidateEntrypoint === undefined
      ? {}
      : { candidateEntrypoint: input.candidateEntrypoint }),
  };
}

class ScopedIpcMain implements Pick<IpcMain, "handle"> {
  readonly #ipcMain: CandidateIpcMain;
  readonly #channels = new Set<string>();
  #closed = false;

  constructor(ipcMain: CandidateIpcMain) {
    this.#ipcMain = ipcMain;
  }

  handle(channel: string, listener: Parameters<IpcMain["handle"]>[1]): void {
    if (this.#closed)
      throw new Error("Desktop Runtime Host candidate IPC is closed");
    if (this.#channels.has(channel)) {
      throw new Error(
        `Desktop Runtime Host candidate registered duplicate IPC: ${channel}`,
      );
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
