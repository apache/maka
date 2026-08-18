import { randomBytes } from 'node:crypto';
import {
  Client,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type FetchLike,
  type McpSubscription,
  type Tool,
  type Transport,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  isMcpStdioConfig,
  resolveMcpRemoteProtocolPreference,
  type McpBoundTool,
  type McpCallResult,
  type McpConfigFile,
  type McpContentBlock,
  type McpNegotiatedProtocol,
  type McpProtocolPreference,
  type McpRemoteServerConfig,
  type McpServerConfig,
  type McpServerStatus,
  type McpTestResult,
  type McpToolBinding,
  type McpToolDescriptor,
  type McpToolSnapshot,
} from '@maka/core/mcp';
import {
  formatMcpDiagnosticText,
  MCP_DIAGNOSTIC_INPUT_CODE_UNITS,
  MCP_ERROR_DIAGNOSTIC_CODE_POINTS,
} from './diagnostic-text.js';
import {
  formatMcpHeaderExclusionWarning,
  partitionMcpHeaderToolDefinitions,
  validateMcpHeaderArguments,
  type McpHeaderDeclaration,
} from './sep-2243.js';
import { createMcpToolBinding, parseMcpToolBinding } from './tool-binding.js';
import { McpToolCallError, normalizeToolCallError } from './tool-call-error.js';
import { discoverMcpTools, type McpDiscoveredTool } from './tool-discovery.js';
import { McpToolCallPreparer, type McpToolCallPreparationState } from './tool-output-validation.js';

export { McpToolCallError } from './tool-call-error.js';

const DEFAULT_TIMEOUTS = {
  remoteConnectMs: 30_000,
  stdioConnectMs: 60_000,
  listToolsMs: 15_000,
  callToolMs: 600_000,
} as const;
const STDERR_LINES = 10;
const STDERR_LINE_CHARS = 2_000;
const STDERR_OVERSIZED_LINE = '[stderr line omitted: exceeds diagnostic limit]';
const STDERR_CONTINUATION = '[stderr continuation omitted]';
const MAX_SUMMARIZED_ERROR_BLOCKS = 100;
const OVERSIZED_TOOL_ERROR_CONTENT = 'server returned oversized error content';
const MAX_TOOL_REFRESH_PASSES = 3;
const TOOL_REFRESH_BURST_IDLE_MS = 1_000;

export interface McpClientManagerOptions {
  clientName?: string;
  clientVersion?: string;
  timeouts?: Partial<McpTimeouts>;
  now?: () => number;
  excludedStdioEnvironmentKeys?: readonly string[];
}

export type McpManagerChangeListener = (status: McpServerStatus) => void;

type McpTimeouts = { [K in keyof typeof DEFAULT_TIMEOUTS]: number };

interface ToolSnapshotEntry {
  definition: Tool;
  definitionFingerprint: string;
  descriptor: McpToolDescriptor;
  binding: McpToolBinding;
  connectionGeneration: number;
  headerDeclarations: readonly McpHeaderDeclaration[];
  callPreparation?: McpToolCallPreparationState;
}

interface ToolRefreshState {
  readonly client: Client;
  readonly connectionGeneration: number;
  // Initial discovery runs before the status transitions to 'connected'; it
  // still owns the same single-flight gate so a list-changed notification
  // received while the first tools/list is in flight joins this pass instead
  // of racing or being dropped.
  readonly initial: boolean;
  // Connect-scoped abort for the initial pass: cancelling an installation
  // must interrupt the in-flight first tools/list instead of waiting out the
  // server. Post-connect refreshes are torn down via the connection identity
  // guard and transport close instead.
  readonly signal?: AbortSignal;
  pending: boolean;
  pendingNotification: boolean;
  promise: Promise<ToolRefreshResult>;
}

interface ToolRefreshResult {
  readonly descriptors: McpToolDescriptor[];
  readonly initialSnapshot?: Map<string, ToolSnapshotEntry>;
  readonly suppressed: boolean;
}

interface ToolRefreshOptions {
  readonly notification?: boolean;
  readonly initial?: boolean;
  readonly signal?: AbortSignal;
}

interface ToolRefreshNotificationState {
  readonly client: Client;
  readonly connectionGeneration: number;
  // This state intentionally outlives one refresh promise. A notification
  // sent just after every response must consume the same bounded pass budget,
  // while an idle interval starts a later independent burst with a new one.
  refreshPasses: number;
  suppressed: boolean;
  lastPassCompletedAt?: number;
}

interface Connection {
  config: McpServerConfig;
  fingerprint: string;
  client?: Client;
  transport?: Transport;
  stdioTransport?: StdioClientTransport;
  connectPromise?: Promise<McpServerStatus>;
  connectController?: AbortController;
  status: McpServerStatus;
  toolSnapshot: Map<string, ToolSnapshotEntry>;
  connectionGeneration?: number;
  refreshState?: ToolRefreshState;
  refreshNotificationState?: ToolRefreshNotificationState;
  enforceMcpHeaders: boolean;
  refreshDiagnostic?: string;
  subscription?: McpSubscription;
  subscriptionDiagnostic?: string;
  closing: boolean;
}

interface ToolBindingTarget {
  readonly connection: Connection;
  readonly snapshot: ToolSnapshotEntry;
}

interface OpenedMcpClient {
  client: Client;
  events: McpClientEventBridge;
  transport: Transport;
  stdioTransport?: StdioClientTransport;
  kind: 'stdio' | 'streamable-http' | 'sse';
  isClosed(): boolean;
}

interface McpClientEventBridge {
  activate(handlers: { onToolsChanged(error: Error | null): void }): {
    clientErrors: Error[];
    pendingToolsChanged?: { error: Error | null };
  };
}

export class McpClientManager {
  private readonly connections = new Map<string, Connection>();
  private bindingIndex = new Map<McpToolBinding, ToolBindingTarget>();
  private readonly listeners = new Set<McpManagerChangeListener>();
  private syncQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly timeouts: McpTimeouts;
  private readonly now: () => number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly excludedStdioEnvironmentKeys: readonly string[];
  private readonly toolCallPreparer = new McpToolCallPreparer();
  private readonly bindingManagerId = randomBytes(16).toString('base64url');
  private lastConnectionGeneration = 0;
  private callableSnapshot: McpToolSnapshot = Object.freeze({
    revision: 0,
    tools: Object.freeze([]),
  });

  constructor(options: McpClientManagerOptions = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.now = options.now ?? Date.now;
    this.clientName = options.clientName ?? 'maka';
    this.clientVersion = options.clientVersion ?? '0.1.0';
    this.excludedStdioEnvironmentKeys = [...(options.excludedStdioEnvironmentKeys ?? [])];
  }

  onChange(listener: McpManagerChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sync(config: McpConfigFile): Promise<void> {
    if (this.closed) return Promise.reject(new Error('MCP client manager is closed'));
    const snapshot = structuredClone(config);
    const operation = this.syncQueue.catch(() => {}).then(() => this.syncNow(snapshot));
    this.syncQueue = operation;
    return operation;
  }

  private async syncNow(config: McpConfigFile): Promise<void> {
    const desired = new Set(Object.keys(config.mcpServers));
    await Promise.all(
      [...this.connections.keys()]
        .filter((serverId) => !desired.has(serverId))
        .map((serverId) => this.disconnect(serverId, true)),
    );
    const connectIds: string[] = [];
    for (const [serverId, serverConfig] of Object.entries(config.mcpServers)) {
      const fingerprint = stableConfigFingerprint(serverConfig);
      const current = this.connections.get(serverId);
      if (current && current.fingerprint !== fingerprint) await this.disconnect(serverId, true);
      if (!this.connections.has(serverId)) {
        this.connections.set(serverId, {
          config: serverConfig,
          fingerprint,
          closing: false,
          toolSnapshot: new Map(),
          enforceMcpHeaders: false,
          status: this.makeStatus(
            serverId,
            serverConfig.enabled === false ? 'disabled' : 'disconnected',
          ),
        });
      }
      if (serverConfig.enabled !== false) connectIds.push(serverId);
    }
    await Promise.all(connectIds.map((serverId) => this.connect(serverId).catch(() => {})));
  }

  statuses(): McpServerStatus[] {
    return [...this.connections.values()].map((entry) => cloneStatus(entry.status));
  }

  status(serverId: string): McpServerStatus | undefined {
    const value = this.connections.get(serverId)?.status;
    return value ? cloneStatus(value) : undefined;
  }

  toolSnapshot(): McpToolSnapshot {
    return this.callableSnapshot;
  }

  async connect(serverId: string): Promise<McpServerStatus> {
    if (this.closed) throw new Error('MCP client manager is closed');
    const entry = this.requireConnection(serverId);
    if (entry.closing) throw new Error(`MCP server "${serverId}" is closing`);
    if (entry.config.enabled === false) return cloneStatus(entry.status);
    if (entry.status.state === 'connected') return cloneStatus(entry.status);
    if (entry.connectPromise) return entry.connectPromise;
    const controller = new AbortController();
    entry.connectController = controller;
    const promise = this.connectEntry(serverId, entry, controller.signal).finally(() => {
      if (entry.connectPromise === promise) entry.connectPromise = undefined;
      if (entry.connectController === controller) entry.connectController = undefined;
    });
    entry.connectPromise = promise;
    return promise;
  }

  cancelConnect(serverId: string): boolean {
    const entry = this.connections.get(serverId);
    if (entry?.status.state !== 'connecting') return false;
    const controller = entry.connectController;
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new Error(`MCP installation cancelled: ${serverId}`));
    return true;
  }

  async reconnect(serverId: string): Promise<McpServerStatus> {
    await this.disconnect(serverId, false);
    return this.connect(serverId);
  }

  async disconnect(serverId: string, remove = false): Promise<void> {
    const entry = this.connections.get(serverId);
    if (!entry) return;
    entry.closing = true;
    entry.connectController?.abort(new Error(`MCP connection closed: ${serverId}`));
    const connectPromise = entry.connectPromise;
    const client = entry.client;
    const transport = entry.transport;
    const subscription = entry.subscription;
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdioTransport = undefined;
    entry.subscription = undefined;
    this.replaceToolSnapshot(entry, new Map());
    entry.connectionGeneration = undefined;
    entry.refreshState = undefined;
    entry.refreshNotificationState = undefined;
    entry.enforceMcpHeaders = false;
    entry.refreshDiagnostic = undefined;
    entry.subscriptionDiagnostic = undefined;
    await safeClose(client, transport, subscription);
    await connectPromise?.catch(() => {});
    if (remove) {
      this.connections.delete(serverId);
      return;
    }
    entry.closing = false;
    this.update(entry, {
      ...this.makeStatus(serverId, entry.config.enabled === false ? 'disabled' : 'disconnected'),
      stderrTail: entry.status.stderrTail,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const closing = [...this.connections.values()].map((entry) => {
      entry.closing = true;
      entry.connectController?.abort(
        new Error(`MCP client manager closed: ${entry.status.serverId}`),
      );
      this.replaceToolSnapshot(entry, new Map());
      entry.connectionGeneration = undefined;
      entry.refreshState = undefined;
      entry.refreshNotificationState = undefined;
      entry.enforceMcpHeaders = false;
      const subscription = entry.subscription;
      entry.subscription = undefined;
      entry.refreshDiagnostic = undefined;
      entry.subscriptionDiagnostic = undefined;
      return safeClose(entry.client, entry.transport, subscription);
    });
    await Promise.all(closing);
    await this.syncQueue.catch(() => {});
    await Promise.all(
      [...this.connections.keys()].map((serverId) => this.disconnect(serverId, true)),
    );
  }

  async refreshTools(serverId: string): Promise<McpToolDescriptor[]> {
    if (this.closed) throw new Error('MCP client manager is closed');
    const entry = this.requireConnection(serverId);
    const connectingRefresh = entry.refreshState;
    // Initial discovery already defines the first callable snapshot. An
    // explicit refresh during that connect joins it without requesting the
    // notification-style follow-up pass used after publication.
    if (
      entry.status.state === 'connecting' &&
      entry.client &&
      connectingRefresh?.client === entry.client &&
      connectingRefresh.connectionGeneration === entry.connectionGeneration
    ) {
      return (await connectingRefresh.promise).descriptors;
    }
    if (!entry.client || entry.status.state !== 'connected') await this.connect(serverId);
    const client = entry.client;
    if (!client) throw new Error(`MCP server "${serverId}" is not connected`);
    const connectionGeneration = this.requireConnectionGeneration(serverId, entry);
    const activeRefresh = entry.refreshState;
    const refreshIsActive =
      activeRefresh?.client === client &&
      activeRefresh.connectionGeneration === connectionGeneration;
    if (!refreshIsActive) {
      entry.refreshNotificationState = {
        client,
        connectionGeneration,
        refreshPasses: 0,
        suppressed: false,
      };
    }
    const result = await this.startToolRefresh(serverId, entry, client, connectionGeneration);
    return result.descriptors;
  }

  private startToolRefresh(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
    options: ToolRefreshOptions = {},
  ): Promise<ToolRefreshResult> {
    const notification = options.notification ?? false;
    if (
      entry.refreshState?.client === client &&
      entry.refreshState.connectionGeneration === connectionGeneration
    ) {
      entry.refreshState.pending = true;
      entry.refreshState.pendingNotification ||= notification;
      return entry.refreshState.promise;
    }

    const state: ToolRefreshState = {
      client,
      connectionGeneration,
      initial: options.initial ?? false,
      signal: options.signal,
      pending: false,
      pendingNotification: notification,
      promise: Promise.resolve({ descriptors: [], suppressed: false }),
    };
    entry.refreshState = state;
    // Start on the next microtask so the generation-owned gate is installed
    // before even a synchronous no-capability refresh can settle and release it.
    state.promise = Promise.resolve().then(() => this.refreshToolLoop(serverId, entry, state));
    return state.promise;
  }

  private async refreshToolsAfterNotification(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
  ): Promise<McpToolDescriptor[]> {
    let notificationState = entry.refreshNotificationState;
    if (
      notificationState?.client !== client ||
      notificationState.connectionGeneration !== connectionGeneration
    ) {
      notificationState = {
        client,
        connectionGeneration,
        refreshPasses: 0,
        suppressed: false,
      };
      entry.refreshNotificationState = notificationState;
    }
    const activeRefresh = entry.refreshState;
    if (
      activeRefresh?.client === client &&
      activeRefresh.connectionGeneration === connectionGeneration
    ) {
      activeRefresh.pending = true;
      activeRefresh.pendingNotification = true;
      return (await activeRefresh.promise).descriptors;
    }
    if (
      notificationState.lastPassCompletedAt !== undefined &&
      this.now() - notificationState.lastPassCompletedAt >= TOOL_REFRESH_BURST_IDLE_MS
    ) {
      notificationState.refreshPasses = 0;
      notificationState.suppressed = false;
    }
    if (notificationState.suppressed) {
      return Promise.reject(this.toolRefreshFrequencyError(serverId));
    }
    if (notificationState.refreshPasses >= MAX_TOOL_REFRESH_PASSES) {
      notificationState.suppressed = true;
      return Promise.reject(this.toolRefreshFrequencyError(serverId));
    }
    const result = await this.startToolRefresh(serverId, entry, client, connectionGeneration, {
      notification: true,
    });
    return result.descriptors;
  }

  async callTool(
    binding: McpToolBinding,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    const identity = parseMcpToolBinding(binding);
    if (!identity) {
      throw new McpToolCallError('unknown', 'unknown', 'tool binding is invalid');
    }
    if (this.closed) {
      throw new McpToolCallError('unknown', 'unknown', 'client manager is closed');
    }
    const target = this.bindingIndex.get(binding);
    const entry = target?.connection;
    const snapshot = target?.snapshot;
    const serverId = snapshot?.descriptor.serverId ?? 'unknown';
    const toolName = snapshot?.descriptor.name ?? 'unknown';
    if (
      identity.managerId !== this.bindingManagerId ||
      !entry ||
      !snapshot ||
      this.connections.get(serverId) !== entry ||
      entry.closing ||
      entry.status.state !== 'connected' ||
      !entry.client ||
      snapshot.binding !== binding ||
      snapshot.connectionGeneration !== identity.connectionGeneration ||
      entry.connectionGeneration !== identity.connectionGeneration ||
      entry.toolSnapshot.get(toolName) !== snapshot
    ) {
      throw new McpToolCallError(serverId, toolName, 'tool binding is stale');
    }
    const client = entry.client;
    const headerArguments = validateMcpHeaderArguments(snapshot.headerDeclarations, args);
    if (!headerArguments.valid) {
      throw new McpToolCallError(
        serverId,
        toolName,
        `unsafe integer argument at ${formatMcpDiagnosticText(headerArguments.path.join('.'))}`,
      );
    }
    const preparation =
      snapshot.callPreparation ??
      (snapshot.callPreparation = this.toolCallPreparer.prepare(snapshot.definition));
    if (!preparation.ok) {
      throw new McpToolCallError(serverId, toolName, 'server advertised an invalid output schema', {
        cause: preparation.cause,
      });
    }
    let result;
    try {
      result = await client.callTool(
        { name: toolName, arguments: args },
        {
          signal: options.signal,
          timeout: options.timeoutMs ?? this.timeouts.callToolMs,
          toolDefinition: structuredClone(preparation.value.definitionForSdk),
        },
      );
    } catch (error) {
      throw normalizeToolCallError(serverId, toolName, error, options.signal);
    }
    // The SDK's legacy compatibility schema defaults a missing content array
    // before returning, but retains deferred-result compatibility fields.
    // Reject every decoded marker and any future content-less result.
    if (
      !Object.hasOwn(result, 'content') ||
      Object.hasOwn(result, 'toolResult') ||
      Object.hasOwn(result, 'task') ||
      Object.hasOwn(result, 'inputRequests') ||
      Object.hasOwn(result, 'requestState')
    ) {
      throw new McpToolCallError(
        serverId,
        toolName,
        'server returned an unsupported deferred tool result',
      );
    }
    if (!Array.isArray(result.content)) {
      throw new McpToolCallError(serverId, toolName, 'server returned invalid content');
    }
    if (result.isError) {
      throw new McpToolCallError(serverId, toolName, summarizeErrorContent(result.content));
    }
    const validateOutput = preparation.value.validateOutput;
    if (validateOutput) {
      if (result.structuredContent === undefined) {
        throw new McpToolCallError(serverId, toolName, 'server returned an invalid tool result');
      }
      let validation;
      try {
        validation = validateOutput(result.structuredContent);
      } catch (cause) {
        throw new McpToolCallError(serverId, toolName, 'server returned an invalid tool result', {
          cause,
        });
      }
      if (!validation.valid) {
        throw new McpToolCallError(serverId, toolName, 'server returned an invalid tool result', {
          cause: new Error(validation.errorMessage),
        });
      }
    }
    return {
      content: result.content.map(normalizeContent),
      structuredContent: result.structuredContent,
    };
  }

  async test(serverId: string): Promise<McpTestResult> {
    const started = this.now();
    const current = this.requireConnection(serverId);
    if (current.config.enabled === false) {
      return {
        ok: false,
        status: { ...cloneStatus(current.status), error: 'MCP server is disabled' },
        latencyMs: this.now() - started,
      };
    }
    try {
      const status = await this.reconnect(serverId);
      return { ok: true, status, latencyMs: this.now() - started };
    } catch {
      return {
        ok: false,
        status: this.status(serverId) ?? this.makeStatus(serverId, 'error'),
        latencyMs: this.now() - started,
      };
    }
  }

  private async connectEntry(
    serverId: string,
    entry: Connection,
    signal: AbortSignal,
  ): Promise<McpServerStatus> {
    let connected: OpenedMcpClient | undefined;
    entry.closing = false;
    entry.refreshDiagnostic = undefined;
    entry.subscription = undefined;
    entry.subscriptionDiagnostic = undefined;
    this.update(entry, {
      ...this.makeStatus(serverId, 'connecting'),
      stderrTail: entry.status.stderrTail,
    });
    try {
      connected = await this.openClient(serverId, entry, signal);
      if (signal.aborted || entry.closing || connected.isClosed()) {
        throw new Error(`MCP server "${serverId}" connection closed during setup`);
      }
      const connectedClient = connected.client;
      const negotiatedProtocol = readNegotiatedProtocol(connectedClient);
      const serverCapabilities = connectedClient.getServerCapabilities();
      const expectsToolListSubscription =
        negotiatedProtocol.era === 'modern' && serverCapabilities?.tools?.listChanged === true;
      let subscription = expectsToolListSubscription
        ? connectedClient.autoOpenedSubscription
        : undefined;
      let subscriptionFailure:
        | { reason: 'missing'; cause?: Error }
        | { reason: 'unhonored' }
        | undefined;
      if (subscription && subscription.honoredFilter.toolsListChanged !== true) {
        // close() settles the handle locally before sending its cancellation
        // notification. Do not let an uncooperative server hold setup open by
        // never answering that best-effort notification.
        void subscription.close().catch(() => {});
        subscription = undefined;
        subscriptionFailure = { reason: 'unhonored' };
      }
      entry.client = connectedClient;
      entry.transport = connected.transport;
      entry.stdioTransport = connected.stdioTransport;
      entry.subscription = subscription;
      const connectionGeneration = this.allocateConnectionGeneration();
      entry.connectionGeneration = connectionGeneration;
      entry.enforceMcpHeaders =
        connected.kind === 'streamable-http' && negotiatedProtocol.era === 'modern';

      if (negotiatedProtocol.era === 'legacy') {
        // Legacy servers commonly emit this notification without advertising
        // the optional listChanged flag. Keep that compatibility at the
        // manager boundary; modern connections use the SDK subscription path.
        connectedClient.setNotificationHandler('notifications/tools/list_changed', async () => {
          this.handleToolsChanged(serverId, entry, connectedClient, connectionGeneration, null);
        });
      }

      const bufferedEvents = connected.events.activate({
        onToolsChanged: (error) => {
          this.handleToolsChanged(serverId, entry, connectedClient, connectionGeneration, error);
        },
      });
      if (expectsToolListSubscription && !subscription && !subscriptionFailure) {
        subscriptionFailure = {
          reason: 'missing',
          cause: bufferedEvents.clientErrors.at(-1),
        };
      }
      entry.subscriptionDiagnostic = subscriptionFailure
        ? subscriptionFailure.reason === 'unhonored'
          ? formatSubscriptionDiagnostic(serverId, 'did not honor tool-list changes')
          : formatSubscriptionDiagnostic(serverId, 'is unavailable', subscriptionFailure.cause)
        : undefined;
      // Initial discovery shares the generation-fenced, single-flight refresh
      // owner with explicit refreshes and live change signals. A notification
      // arriving while the first tools/list is in flight therefore joins that
      // pass instead of publishing a snapshot the server already marked stale.
      const initialRefreshPromise = this.startToolRefresh(
        serverId,
        entry,
        connectedClient,
        connectionGeneration,
        { initial: true, signal },
      );
      if (bufferedEvents.pendingToolsChanged) {
        this.handleToolsChanged(
          serverId,
          entry,
          connectedClient,
          connectionGeneration,
          bufferedEvents.pendingToolsChanged.error,
        );
      }
      const initialRefresh = await initialRefreshPromise;
      if (
        signal.aborted ||
        entry.closing ||
        connected.isClosed() ||
        entry.client !== connectedClient ||
        entry.connectionGeneration !== connectionGeneration
      ) {
        throw new Error(`MCP server "${serverId}" connection changed during tool discovery`);
      }
      const initialSnapshot = initialRefresh.initialSnapshot;
      if (!initialSnapshot) {
        throw new Error(`MCP server "${serverId}" returned no initial tool snapshot`);
      }
      // Initial discovery prepares snapshots while the connection is still
      // connecting, but publication and the connected status transition stay
      // in one synchronous commit. Observers can therefore never advertise a
      // binding that callTool still rejects as not connected.
      this.replaceToolSnapshot(entry, initialSnapshot);
      if (initialRefresh.suppressed) {
        entry.refreshDiagnostic = errorMessage(this.toolRefreshFrequencyError(serverId));
      }
      this.update(entry, {
        serverId,
        state: 'connected',
        transport: connected.kind,
        negotiatedProtocol,
        toolCount: initialRefresh.descriptors.length,
        tools: initialRefresh.descriptors,
        error: projectConnectionDiagnostics(entry),
        stderrTail: entry.status.stderrTail,
        updatedAt: this.now(),
      });
      if (
        signal.aborted ||
        entry.closing ||
        connected.isClosed() ||
        entry.client !== connectedClient ||
        entry.connectionGeneration !== connectionGeneration
      ) {
        throw safeMcpOperationError(
          serverId,
          'connection changed during tool discovery',
          undefined,
        );
      }
      if (subscription) {
        this.observeSubscriptionClose(
          serverId,
          entry,
          connectedClient,
          connectionGeneration,
          subscription,
        );
      }
      return cloneStatus(entry.status);
    } catch (error) {
      const exposedError = safeMcpOperationError(
        serverId,
        signal.aborted ? 'connection aborted' : 'connection failed',
        error,
        !signal.aborted,
      );
      await safeClose(
        connected?.client ?? entry.client,
        connected?.transport ?? entry.transport,
        connected?.client.autoOpenedSubscription ?? entry.subscription,
      );
      if (!connected || !entry.client || entry.client === connected.client) {
        entry.client = undefined;
        entry.transport = undefined;
        entry.stdioTransport = undefined;
        entry.subscription = undefined;
        this.replaceToolSnapshot(entry, new Map());
        entry.connectionGeneration = undefined;
        entry.refreshState = undefined;
        entry.refreshNotificationState = undefined;
        entry.enforceMcpHeaders = false;
        entry.refreshDiagnostic = undefined;
        entry.subscriptionDiagnostic = undefined;
      }
      if (signal.aborted) {
        if (!entry.closing && this.connections.get(serverId) === entry) {
          this.update(entry, {
            ...this.makeStatus(serverId, 'disconnected'),
            stderrTail: entry.status.stderrTail,
          });
        }
      } else {
        this.markError(entry, exposedError);
      }
      throw exposedError;
    }
  }

  private async openClient(
    serverId: string,
    entry: Connection,
    signal: AbortSignal,
  ): Promise<OpenedMcpClient> {
    if (isMcpStdioConfig(entry.config)) {
      const transport = new StdioClientTransport({
        command: entry.config.command,
        args: entry.config.args,
        cwd: entry.config.cwd,
        env: buildStdioEnvironment(
          entry.config.env,
          process.env,
          this.excludedStdioEnvironmentKeys,
        ),
        stderr: 'pipe',
      });
      attachStderrTail(transport, entry, () => {
        if (this.connections.get(serverId) === entry) this.emit(entry.status);
      });
      const { client, events } = this.createClient('legacy');
      const isClosed = this.watchClientClose(serverId, entry, client);
      try {
        await client.connect(transport, { timeout: this.timeouts.stdioConnectMs, signal });
        return {
          client,
          events,
          transport,
          stdioTransport: transport,
          kind: 'stdio',
          isClosed,
        };
      } catch (error) {
        await safeClose(client, transport);
        throw enrichStdioError(error, entry.status.stderrTail);
      }
    }
    const remoteConfig: McpRemoteServerConfig = entry.config;
    const requested = remoteConfig.transport ?? 'auto';
    const preference = resolveMcpRemoteProtocolPreference(remoteConfig);
    if (requested === 'sse' && preference !== 'legacy') {
      throw new Error(`MCP legacy SSE transport does not support protocol ${preference}`);
    }
    let streamableFailure: unknown;
    if (requested !== 'sse') {
      const evidence = createStreamableHandshakeEvidence();
      const { client, events } = this.createClient(preference);
      const transport = new StreamableHTTPClientTransport(new URL(remoteConfig.url), {
        requestInit: { headers: remoteConfig.headers },
        fetch: evidence.fetch,
      });
      const isClosed = this.watchClientClose(serverId, entry, client);
      try {
        await connectRemoteCandidate(client, transport, this.timeouts.remoteConnectMs, signal);
        return { client, events, transport, kind: 'streamable-http', isClosed };
      } catch (error) {
        const producedProtocolEvidence =
          evidence.hasAcceptedInitialize() ||
          client.getProtocolEra() !== undefined ||
          client.getNegotiatedProtocolVersion() !== undefined;
        await safeClose(client, transport);
        if (
          !shouldFallbackToLegacySse({
            remoteConfig,
            error,
            signal,
            producedProtocolEvidence,
          })
        ) {
          throw error;
        }
        streamableFailure = error;
      }
    }
    const { client, events } = this.createClient('legacy');
    const transport = new SSEClientTransport(new URL(remoteConfig.url), {
      requestInit: { headers: remoteConfig.headers },
    });
    const isClosed = this.watchClientClose(serverId, entry, client);
    try {
      await connectRemoteCandidate(client, transport, this.timeouts.remoteConnectMs, signal);
      return { client, events, transport, kind: 'sse', isClosed };
    } catch (error) {
      await safeClose(client, transport);
      if (streamableFailure !== undefined) {
        throw new AggregateError(
          [streamableFailure, error],
          'Streamable HTTP and legacy SSE connection attempts failed',
        );
      }
      throw error;
    }
  }

  private createClient(preference: McpProtocolPreference): {
    client: Client;
    events: McpClientEventBridge;
  } {
    let bufferedClientError: Error | undefined;
    let pendingToolsChanged: { error: Error | null } | undefined;
    let liveHandlers:
      | {
          onToolsChanged(error: Error | null): void;
        }
      | undefined;
    const client = new Client(
      { name: this.clientName, version: this.clientVersion },
      {
        capabilities: {},
        versionNegotiation: versionNegotiationFor(preference),
        inputRequired: { autoFulfill: false },
        enforceStrictCapabilities: false,
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: (error) => {
              if (liveHandlers) {
                liveHandlers.onToolsChanged(error);
              } else {
                pendingToolsChanged = { error };
              }
            },
          },
        },
      },
    );
    client.onerror = (error) => {
      // client.onerror is a client-wide transport channel. It can explain why
      // the SDK failed to auto-open a subscription during connect, but after
      // activation it cannot safely be attributed to that subscription.
      if (!liveHandlers) bufferedClientError = error;
    };
    return {
      client,
      events: {
        activate: (handlers) => {
          if (liveHandlers) throw new Error('MCP client event bridge is already active');
          liveHandlers = handlers;
          const result = {
            clientErrors: bufferedClientError ? [bufferedClientError] : [],
            ...(pendingToolsChanged ? { pendingToolsChanged } : {}),
          };
          bufferedClientError = undefined;
          pendingToolsChanged = undefined;
          return result;
        },
      },
    };
  }

  private handleToolsChanged(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
    error: Error | null,
  ): void {
    if (!this.isCurrentClient(serverId, entry, client, connectionGeneration)) return;
    if (error) {
      const exposed = safeMcpOperationError(serverId, 'tool-list change signal failed', error);
      entry.refreshDiagnostic = errorMessage(exposed);
      this.publishConnectionDiagnostics(entry);
      return;
    }
    void this.refreshToolsAfterNotification(serverId, entry, client, connectionGeneration).catch(
      (failure) => {
        if (!this.isCurrentClient(serverId, entry, client, connectionGeneration)) return;
        const diagnostic = errorMessage(failure);
        if (entry.refreshDiagnostic === diagnostic) return;
        entry.refreshDiagnostic = diagnostic;
        this.publishConnectionDiagnostics(entry);
      },
    );
  }

  private observeSubscriptionClose(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
    subscription: McpSubscription,
  ): void {
    void subscription.closed.then((reason) => {
      if (reason === 'local' || entry.subscription !== subscription) return;
      this.recordSubscriptionDiagnostic(
        serverId,
        entry,
        client,
        connectionGeneration,
        formatSubscriptionDiagnostic(serverId, `closed ${reason}`),
      );
    });
  }

  private recordSubscriptionDiagnostic(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
    diagnostic: string,
  ): void {
    if (!this.isCurrentClient(serverId, entry, client, connectionGeneration)) return;
    entry.subscriptionDiagnostic = diagnostic;
    if (entry.status.state === 'connected') this.publishConnectionDiagnostics(entry);
  }

  private publishConnectionDiagnostics(entry: Connection): void {
    if (entry.status.state !== 'connected') return;
    this.update(entry, {
      ...entry.status,
      error: projectConnectionDiagnostics(entry),
      updatedAt: this.now(),
    });
  }

  private isCurrentClient(
    serverId: string,
    entry: Connection,
    client: Client,
    connectionGeneration: number,
  ): boolean {
    return (
      this.connections.get(serverId) === entry &&
      entry.client === client &&
      entry.connectionGeneration === connectionGeneration &&
      !entry.closing
    );
  }

  private async refreshToolLoop(
    serverId: string,
    entry: Connection,
    state: ToolRefreshState,
  ): Promise<ToolRefreshResult> {
    let latestSnapshot:
      | { entries: Map<string, ToolSnapshotEntry>; descriptors: McpToolDescriptor[] }
      | undefined;
    const finish = (
      snapshot: NonNullable<typeof latestSnapshot>,
      suppressed: boolean,
    ): ToolRefreshResult => ({
      descriptors: snapshot.descriptors.map(cloneTool),
      ...(state.initial ? { initialSnapshot: snapshot.entries } : {}),
      suppressed,
    });
    try {
      while (true) {
        const notificationPass = state.pendingNotification;
        state.pending = false;
        state.pendingNotification = false;
        if (notificationPass) {
          const notificationState = entry.refreshNotificationState;
          if (
            notificationState?.client !== state.client ||
            notificationState.connectionGeneration !== state.connectionGeneration
          ) {
            throw safeMcpOperationError(
              serverId,
              'connection changed during tool refresh',
              undefined,
            );
          }
          if (notificationState.suppressed) {
            if (state.initial && latestSnapshot) return finish(latestSnapshot, true);
            throw this.toolRefreshFrequencyError(serverId);
          }
          if (notificationState.refreshPasses >= MAX_TOOL_REFRESH_PASSES) {
            notificationState.suppressed = true;
            if (state.initial && latestSnapshot) return finish(latestSnapshot, true);
            throw this.toolRefreshFrequencyError(serverId);
          }
          notificationState.refreshPasses += 1;
        }
        let definitions: McpDiscoveredTool[] | undefined;
        let failure: unknown;
        try {
          definitions = shouldDiscoverTools(state.client)
            ? await listAllTools(state.client, serverId, this.timeouts.listToolsMs, state.signal)
            : [];
        } catch (error) {
          failure = error;
        }
        if (!this.ownsToolRefresh(serverId, entry, state)) {
          throw safeMcpOperationError(serverId, 'connection changed during tool refresh', failure);
        }
        const notificationState = entry.refreshNotificationState;
        const notificationStateMatches =
          notificationState?.client === state.client &&
          notificationState.connectionGeneration === state.connectionGeneration;
        const refreshSuppressed = notificationStateMatches && notificationState.suppressed;
        if (failure !== undefined) {
          if (refreshSuppressed) throw this.toolRefreshFrequencyError(serverId);
          const exposed = safeMcpOperationError(serverId, 'tool refresh failed', failure);
          entry.refreshDiagnostic = errorMessage(exposed);
          this.publishConnectionDiagnostics(entry);
          if (!this.ownsToolRefresh(serverId, entry, state)) {
            throw safeMcpOperationError(
              serverId,
              'connection changed during tool refresh',
              failure,
            );
          }
          if (state.pending) continue;
          throw exposed;
        }
        if (!definitions) {
          if (refreshSuppressed) throw this.toolRefreshFrequencyError(serverId);
          if (state.pending) continue;
          throw new Error(`MCP server "${serverId}" returned no tool definitions`);
        }

        const snapshot = createToolSnapshot(
          serverId,
          definitions,
          entry.enforceMcpHeaders,
          this.bindingManagerId,
          state.connectionGeneration,
          entry.toolSnapshot,
        );
        latestSnapshot = snapshot;
        if (notificationStateMatches) notificationState.lastPassCompletedAt = this.now();
        if (refreshSuppressed) {
          if (state.initial) return finish(snapshot, true);
          throw this.toolRefreshFrequencyError(serverId);
        }
        if (state.pending) continue;
        publishMcpHeaderExclusionWarning(snapshot.warning);
        entry.refreshDiagnostic = undefined;
        if (!state.initial) {
          this.replaceToolSnapshot(entry, snapshot.entries);
          this.update(entry, {
            ...entry.status,
            tools: snapshot.descriptors,
            toolCount: snapshot.descriptors.length,
            error: projectConnectionDiagnostics(entry),
            updatedAt: this.now(),
          });
          // A synchronous status listener can retire this generation during
          // publication. Never hand descriptors for that retired snapshot
          // back to the caller.
          if (!this.ownsToolRefresh(serverId, entry, state)) {
            throw safeMcpOperationError(
              serverId,
              'connection changed during tool refresh',
              undefined,
            );
          }
          if (state.pending) continue;
        }
        return finish(snapshot, false);
      }
    } finally {
      // Release the gate synchronously on every exit. A promise `.finally`
      // runs one microtask after settlement, so a refresh requested in that
      // window would join a settled promise and receive descriptors from a
      // list that started before it asked.
      if (entry.refreshState === state) entry.refreshState = undefined;
    }
  }

  private ownsToolRefresh(serverId: string, entry: Connection, state: ToolRefreshState): boolean {
    return (
      this.connections.get(serverId) === entry &&
      !entry.closing &&
      entry.client === state.client &&
      entry.connectionGeneration === state.connectionGeneration &&
      (entry.status.state === 'connected' || (state.initial && entry.status.state === 'connecting'))
    );
  }

  private toolRefreshFrequencyError(serverId: string): Error {
    return safeMcpOperationError(
      serverId,
      'tool refresh failed',
      new Error('tool list changed too frequently during discovery'),
    );
  }

  private watchClientClose(serverId: string, entry: Connection, client: Client): () => boolean {
    let closed = false;
    client.onclose = () => {
      closed = true;
      this.handleTransportClose(serverId, entry, client);
    };
    return () => closed;
  }

  private handleTransportClose(serverId: string, entry: Connection, client: Client): void {
    if (entry.closing || this.connections.get(serverId) !== entry || entry.client !== client) {
      return;
    }
    const subscription = entry.subscription;
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdioTransport = undefined;
    entry.subscription = undefined;
    this.replaceToolSnapshot(entry, new Map());
    entry.connectionGeneration = undefined;
    entry.refreshState = undefined;
    entry.refreshNotificationState = undefined;
    entry.enforceMcpHeaders = false;
    entry.refreshDiagnostic = undefined;
    entry.subscriptionDiagnostic = undefined;
    void subscription?.close().catch(() => {});
    this.update(entry, {
      ...this.makeStatus(serverId, 'disconnected'),
      stderrTail: entry.status.stderrTail,
    });
  }

  private markError(entry: Connection, error: unknown): void {
    this.update(entry, {
      ...this.makeStatus(entry.status.serverId, 'error'),
      error: errorMessage(error),
      stderrTail: entry.status.stderrTail,
    });
  }

  private update(entry: Connection, status: McpServerStatus): void {
    entry.status = status;
    this.emit(status);
  }

  private emit(status: McpServerStatus): void {
    for (const listener of this.listeners) listener(cloneStatus(status));
  }

  private requireConnection(serverId: string): Connection {
    const entry = this.connections.get(serverId);
    if (!entry) throw new Error(`Unknown MCP server: ${serverId}`);
    return entry;
  }

  private requireConnectionGeneration(serverId: string, entry: Connection): number {
    if (!entry.connectionGeneration) {
      throw new Error(`MCP server "${serverId}" has no active connection generation`);
    }
    return entry.connectionGeneration;
  }

  private replaceToolSnapshot(entry: Connection, snapshot: Map<string, ToolSnapshotEntry>): void {
    const nextIndex = new Map(this.bindingIndex);
    for (const previous of entry.toolSnapshot.values()) {
      const target = nextIndex.get(previous.binding);
      if (target?.connection === entry && target.snapshot === previous) {
        nextIndex.delete(previous.binding);
      }
    }
    for (const current of snapshot.values()) {
      if (nextIndex.has(current.binding)) {
        throw new Error('MCP tool binding collision');
      }
      nextIndex.set(current.binding, { connection: entry, snapshot: current });
    }
    const nextCallableSnapshot = this.buildCallableSnapshot(entry, snapshot);
    entry.toolSnapshot = snapshot;
    this.bindingIndex = nextIndex;
    this.callableSnapshot = nextCallableSnapshot;
  }

  private buildCallableSnapshot(
    replacedEntry: Connection,
    replacement: ReadonlyMap<string, ToolSnapshotEntry>,
  ): McpToolSnapshot {
    const entries = this.closed
      ? []
      : [...this.connections.values()]
          .filter((entry) => !entry.closing && entry.client && entry.connectionGeneration)
          .flatMap((entry) => [
            ...(entry === replacedEntry ? replacement : entry.toolSnapshot).values(),
          ]);
    const nextBindings = entries.map(({ binding }) => binding).sort(compareText);
    const previousBindings = this.callableSnapshot.tools
      .map(({ binding }) => binding)
      .sort(compareText);
    if (
      nextBindings.length === previousBindings.length &&
      nextBindings.every((binding, index) => binding === previousBindings[index])
    ) {
      return this.callableSnapshot;
    }
    if (this.callableSnapshot.revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('MCP tool snapshot revision exhausted');
    }
    const tools = entries.map(
      ({ descriptor, binding }) =>
        deepFreeze({ descriptor: cloneTool(descriptor), binding }) as McpBoundTool,
    );
    return Object.freeze({
      revision: this.callableSnapshot.revision + 1,
      tools: Object.freeze(tools),
    });
  }

  private allocateConnectionGeneration(): number {
    if (this.lastConnectionGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new Error('MCP connection generation exhausted');
    }
    this.lastConnectionGeneration += 1;
    return this.lastConnectionGeneration;
  }

  private makeStatus(serverId: string, state: McpServerStatus['state']): McpServerStatus {
    return { serverId, state, toolCount: 0, tools: [], updatedAt: this.now() };
  }
}

async function listAllTools(
  client: Client,
  serverId: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<McpDiscoveredTool[]> {
  return discoverMcpTools(
    {
      requestToolsPage: (cursor, timeoutMs) =>
        client.request(
          {
            method: 'tools/list',
            ...(cursor !== undefined ? { params: { cursor } } : {}),
          },
          { timeout: timeoutMs, signal },
        ),
    },
    serverId,
    timeout,
  );
}

function versionNegotiationFor(preference: McpProtocolPreference): VersionNegotiationOptions {
  switch (preference) {
    case 'legacy':
      return { mode: 'legacy' };
    case 'auto':
      return { mode: 'auto' };
    case '2026-07-28':
      return { mode: { pin: '2026-07-28' } };
  }
}

function readNegotiatedProtocol(client: Client): McpNegotiatedProtocol {
  const era = client.getProtocolEra();
  const revision = client.getNegotiatedProtocolVersion();
  if (!era || !revision) {
    throw new Error('MCP SDK connected without a negotiated protocol');
  }
  return { era, revision };
}

function shouldDiscoverTools(client: Client): boolean {
  return !(
    client.getProtocolEra() === 'modern' && client.getServerCapabilities()?.tools === undefined
  );
}

function shouldFallbackToLegacySse(options: {
  remoteConfig: McpRemoteServerConfig;
  error: unknown;
  signal: AbortSignal;
  producedProtocolEvidence: boolean;
}): boolean {
  const { remoteConfig, error, signal, producedProtocolEvidence } = options;
  return (
    (remoteConfig.transport ?? 'auto') === 'auto' &&
    resolveMcpRemoteProtocolPreference(remoteConfig) !== '2026-07-28' &&
    !producedProtocolEvidence &&
    !signal.aborted &&
    SdkHttpError.isInstance(error) &&
    error.code === SdkErrorCode.ClientHttpNotImplemented &&
    (error.status === 404 || error.status === 405)
  );
}

function createStreamableHandshakeEvidence(): {
  fetch: FetchLike;
  hasAcceptedInitialize(): boolean;
} {
  let acceptedInitialize = false;
  return {
    fetch: async (url, init) => {
      // SDK v2 emits notifications/initialized only after the initialize result
      // has passed wire validation and its server identity/capabilities have
      // been accepted. The SDK clears those getters when this notification's
      // HTTP request fails, so retain this one bit outside the Client lifecycle.
      if (readJsonRpcMethods(init?.body).includes('notifications/initialized')) {
        acceptedInitialize = true;
      }
      return globalThis.fetch(url, init);
    },
    hasAcceptedInitialize: () => acceptedInitialize,
  };
}

function readJsonRpcMethods(body: BodyInit | null | undefined): string[] {
  if (typeof body !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((message) =>
    isRecord(message) && typeof message.method === 'string' ? [message.method] : [],
  );
}

function formatSubscriptionDiagnostic(serverId: string, detail: string, cause?: unknown): string {
  return errorMessage(
    safeMcpOperationError(serverId, `tool-list subscription ${detail}`, cause, cause !== undefined),
  );
}

function projectConnectionDiagnostics(entry: Connection): string | undefined {
  const diagnostics = [entry.subscriptionDiagnostic, entry.refreshDiagnostic].filter(
    (value): value is string => Boolean(value),
  );
  if (diagnostics.length === 0) return undefined;
  return formatMcpDiagnosticText(diagnostics.join('\n'), MCP_ERROR_DIAGNOSTIC_CODE_POINTS);
}

function publishMcpHeaderExclusionWarning(warning: string | undefined): void {
  if (!warning) return;
  try {
    console.warn(warning);
  } catch {
    // A diagnostic sink cannot roll back an already-published Tool snapshot.
  }
}

function createToolSnapshot(
  serverId: string,
  definitions: readonly McpDiscoveredTool[],
  enforceMcpHeaders: boolean,
  managerId: string,
  connectionGeneration: number,
  previousEntries?: ReadonlyMap<string, ToolSnapshotEntry>,
): {
  entries: Map<string, ToolSnapshotEntry>;
  descriptors: McpToolDescriptor[];
  warning?: string;
} {
  const tools = definitions.map(({ definition }) => definition);
  const partition = enforceMcpHeaders
    ? partitionMcpHeaderToolDefinitions(tools)
    : {
        valid: tools.map((tool) => ({ tool, declarations: [] })),
        rejected: [],
      };
  const warning = formatMcpHeaderExclusionWarning(partition.rejected);

  const entries = new Map<string, ToolSnapshotEntry>();
  const descriptors: McpToolDescriptor[] = [];
  const discoveredByName = new Map(
    definitions.map((definition) => [definition.definition.name, definition]),
  );
  for (const { tool, declarations } of partition.valid) {
    const discovered = discoveredByName.get(tool.name);
    if (!discovered) {
      throw new Error(`MCP server "${serverId}" lost Tool "${tool.name}" during validation`);
    }
    const definition = discovered.definition;
    const descriptor = descriptorFromTool(serverId, definition);
    const definitionFingerprint = discovered.definitionFingerprint;
    const previous = previousEntries?.get(definition.name);
    const binding =
      previous?.connectionGeneration === connectionGeneration &&
      previous.definitionFingerprint === definitionFingerprint
        ? previous.binding
        : createMcpToolBinding({
            managerId,
            connectionGeneration,
            serverId,
            toolName: definition.name,
            definitionFingerprint,
          });
    entries.set(definition.name, {
      definition,
      definitionFingerprint,
      descriptor,
      binding,
      connectionGeneration,
      headerDeclarations: declarations.map((declaration) => ({
        ...declaration,
        path: [...declaration.path],
      })),
      ...(previous?.connectionGeneration === connectionGeneration &&
      previous.definitionFingerprint === definitionFingerprint &&
      previous.callPreparation
        ? { callPreparation: previous.callPreparation }
        : {}),
    });
    descriptors.push(descriptor);
  }
  return { entries, descriptors, ...(warning ? { warning } : {}) };
}

function descriptorFromTool(serverId: string, tool: Tool): McpToolDescriptor {
  return {
    serverId,
    name: tool.name,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    annotations: tool.annotations ? { ...tool.annotations } : undefined,
  };
}

function normalizeContent(value: unknown): McpContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') return { type: 'unknown', value };
  if (value.type === 'text' && typeof value.text === 'string')
    return { type: 'text', text: value.text };
  if (
    value.type === 'image' &&
    typeof value.data === 'string' &&
    typeof value.mimeType === 'string'
  ) {
    return { type: 'image', data: value.data, mimeType: value.mimeType };
  }
  if (
    value.type === 'audio' &&
    typeof value.data === 'string' &&
    typeof value.mimeType === 'string'
  ) {
    return { type: 'audio', data: value.data, mimeType: value.mimeType };
  }
  if (
    value.type === 'resource' &&
    isRecord(value.resource) &&
    typeof value.resource.uri === 'string'
  ) {
    return {
      type: 'resource',
      uri: value.resource.uri,
      mimeType: stringValue(value.resource.mimeType),
      text: stringValue(value.resource.text),
      blob: stringValue(value.resource.blob),
    };
  }
  if (value.type === 'resource_link' && typeof value.uri === 'string') {
    return {
      type: 'resource_link',
      uri: value.uri,
      name: stringValue(value.name),
      description: stringValue(value.description),
      mimeType: stringValue(value.mimeType),
    };
  }
  return { type: 'unknown', value };
}

function summarizeErrorContent(content: unknown[]): string {
  if (content.length > MAX_SUMMARIZED_ERROR_BLOCKS) return OVERSIZED_TOOL_ERROR_CONTENT;
  const fragments: string[] = [];
  let rawChars = 0;
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    rawChars += block.text.length + (fragments.length > 0 ? 1 : 0);
    if (rawChars > MCP_DIAGNOSTIC_INPUT_CODE_UNITS) {
      return OVERSIZED_TOOL_ERROR_CONTENT;
    }
    fragments.push(block.text);
  }
  const text = fragments.join('\n').trim();
  return text || 'server reported an error';
}

export function buildStdioEnvironment(
  explicit: Record<string, string> = {},
  source = process.env,
  excludedKeys: readonly string[] = [],
): Record<string, string> {
  const result: Record<string, string> = {};
  const exact = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'TMPDIR',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
    'WINDIR',
    'LOCALAPPDATA',
    'APPDATA',
    'TEMP',
    'TMP',
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (exact.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')))
      result[key] = value;
  }
  const environment = { ...result, ...explicit };
  const excluded = new Set(excludedKeys.map((key) => key.toLowerCase()));
  for (const key of Object.keys(environment)) {
    if (excluded.has(key.toLowerCase())) delete environment[key];
  }
  return environment;
}

function attachStderrTail(
  transport: StdioClientTransport,
  entry: Connection,
  onUpdate: () => void,
): void {
  let pending = '';
  let oversized = false;
  let discardingContinuation = false;
  let physicalSuffix = '';
  const append = (lines: string[]) => {
    const rendered = lines
      .map((line) => formatMcpDiagnosticText(line, STDERR_LINE_CHARS))
      .filter(Boolean);
    if (rendered.length === 0) return;
    const next = [...(entry.status.stderrTail ?? []), ...rendered]
      .filter(Boolean)
      .slice(-STDERR_LINES);
    entry.status = { ...entry.status, stderrTail: next, updatedAt: Date.now() };
    onUpdate();
  };
  const retain = (batch: string[], value: string) => {
    if (!value) return;
    batch.push(value);
    if (batch.length > STDERR_LINES) batch.splice(0, batch.length - STDERR_LINES);
  };
  const consume = (value: string, endOfLine: boolean, batch: string[]) => {
    physicalSuffix = value.length >= 2 ? value.slice(-2) : `${physicalSuffix}${value}`.slice(-2);
    if (!oversized && !discardingContinuation) {
      const remaining = MCP_DIAGNOSTIC_INPUT_CODE_UNITS - pending.length;
      if (value.length > remaining) {
        pending = '';
        oversized = true;
      } else {
        pending += value;
      }
    }
    if (!endOfLine) return;
    const continued = physicalSuffix.endsWith('\\') || physicalSuffix.endsWith('\\\r');
    if (discardingContinuation) {
      if (!continued) {
        retain(batch, STDERR_CONTINUATION);
        discardingContinuation = false;
      }
    } else if (continued) {
      pending = '';
      oversized = false;
      discardingContinuation = true;
    } else if (oversized) {
      retain(batch, STDERR_OVERSIZED_LINE);
    } else {
      retain(batch, pending.endsWith('\r') ? pending.slice(0, -1) : pending);
    }
    pending = '';
    if (!discardingContinuation) oversized = false;
    physicalSuffix = '';
  };
  const stream = transport.stderr;
  stream?.on('data', (chunk) => {
    const batch: string[] = [];
    const value = String(chunk);
    let offset = 0;
    for (let newline = value.indexOf('\n', offset); newline >= 0; ) {
      consume(value.slice(offset, newline), true, batch);
      offset = newline + 1;
      newline = value.indexOf('\n', offset);
    }
    consume(value.slice(offset), false, batch);
    append(batch);
  });
  const flush = () => {
    if (!pending && !oversized && !discardingContinuation) return;
    const batch: string[] = [];
    retain(
      batch,
      discardingContinuation ? STDERR_CONTINUATION : oversized ? STDERR_OVERSIZED_LINE : pending,
    );
    append(batch);
    pending = '';
    oversized = false;
    discardingContinuation = false;
    physicalSuffix = '';
  };
  stream?.once('end', flush);
  stream?.once('close', flush);
}

function enrichStdioError(error: unknown, stderrTail?: string[]): Error {
  const suffix = stderrTail?.length ? `\nstderr:\n${stderrTail.join('\n')}` : '';
  return new Error(`${errorMessage(error)}${suffix}`, { cause: error });
}

async function safeClose(
  client?: Client,
  transport?: Transport,
  subscription?: McpSubscription,
): Promise<void> {
  const subscriptionClose = subscription?.close().catch(() => {});
  await Promise.all([
    subscriptionClose,
    client?.close().catch(() => {}),
    transport?.close().catch(() => {}),
  ]);
}

async function connectRemoteCandidate(
  client: Client,
  transport: Transport,
  timeout: number,
  signal: AbortSignal,
): Promise<void> {
  const closeOnAbort = () => {
    // SDK v2's server/discover probe currently uses its timeout but not the
    // Client.connect signal. Closing the candidate transport aborts that probe
    // instead of leaving a late handshake running after manager cancellation.
    void transport.close().catch(() => {});
  };
  if (signal.aborted) {
    await transport.close().catch(() => {});
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason ?? 'MCP connection aborted'));
  }
  signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    await client.connect(transport, { timeout, signal });
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
  }
}

function stableConfigFingerprint(config: McpServerConfig): string {
  return JSON.stringify(sortValue(config));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function cloneStatus(status: McpServerStatus): McpServerStatus {
  return {
    ...status,
    negotiatedProtocol: status.negotiatedProtocol ? { ...status.negotiatedProtocol } : undefined,
    tools: status.tools.map(cloneTool),
    stderrTail: status.stderrTail?.slice(),
  };
}

function cloneTool(tool: McpToolDescriptor): McpToolDescriptor {
  return {
    ...tool,
    inputSchema: structuredClone(tool.inputSchema),
    annotations: tool.annotations ? { ...tool.annotations } : undefined,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function errorMessage(error: unknown): string {
  return formatMcpDiagnosticText(
    error instanceof Error ? error.message : String(error),
    MCP_ERROR_DIAGNOSTIC_CODE_POINTS,
  );
}

function safeMcpOperationError(
  serverId: string,
  operation: string,
  cause: unknown,
  includeCause = cause !== undefined,
): Error {
  const prefix = `MCP server ${JSON.stringify(formatMcpDiagnosticText(serverId))} ${operation}`;
  const message = includeCause ? `${prefix}: ${errorMessage(cause)}` : prefix;
  return new Error(formatMcpDiagnosticText(message, MCP_ERROR_DIAGNOSTIC_CODE_POINTS), { cause });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
