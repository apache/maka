import { randomBytes } from 'node:crypto';
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  isMcpStdioConfig,
  type McpBoundTool,
  type McpCallResult,
  type McpConfigFile,
  type McpContentBlock,
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
  callPreparation?: McpToolCallPreparationState;
}

interface ToolRefreshState {
  readonly client: Client;
  readonly connectionGeneration: number;
  pending: boolean;
  promise: Promise<McpToolDescriptor[]>;
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
  closing: boolean;
}

interface ToolBindingTarget {
  readonly connection: Connection;
  readonly snapshot: ToolSnapshotEntry;
}

interface OpenedMcpClient {
  client: Client;
  transport: Transport;
  stdioTransport?: StdioClientTransport;
  kind: 'stdio' | 'streamable-http' | 'sse';
  isClosed(): boolean;
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
  private toolSnapshotRevisionValue = 0;
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
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdioTransport = undefined;
    this.replaceToolSnapshot(entry, new Map());
    entry.connectionGeneration = undefined;
    entry.refreshState = undefined;
    await safeClose(client, transport);
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
      return safeClose(entry.client, entry.transport);
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
    if (!entry.client || entry.status.state !== 'connected') await this.connect(serverId);
    const client = entry.client;
    if (!client) throw new Error(`MCP server "${serverId}" is not connected`);
    const connectionGeneration = this.requireConnectionGeneration(serverId, entry);
    if (
      entry.refreshState?.client === client &&
      entry.refreshState.connectionGeneration === connectionGeneration
    ) {
      entry.refreshState.pending = true;
      return entry.refreshState.promise;
    }

    const state: ToolRefreshState = {
      client,
      connectionGeneration,
      pending: false,
      promise: Promise.resolve([]),
    };
    state.promise = this.refreshToolLoop(serverId, entry, state).finally(() => {
      if (entry.refreshState === state) entry.refreshState = undefined;
    });
    entry.refreshState = state;
    return state.promise;
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
    this.update(entry, {
      ...entry.status,
      state: 'connecting',
      error: undefined,
      updatedAt: this.now(),
    });
    try {
      connected = await this.openClient(serverId, entry, signal);
      if (signal.aborted || entry.closing || connected.isClosed()) {
        throw new Error(`MCP server "${serverId}" connection closed during setup`);
      }
      entry.client = connected.client;
      entry.transport = connected.transport;
      entry.stdioTransport = connected.stdioTransport;
      const connectionGeneration = this.allocateConnectionGeneration();
      entry.connectionGeneration = connectionGeneration;
      const definitions = await listAllTools(
        connected.client,
        serverId,
        this.timeouts.listToolsMs,
        signal,
      );
      if (
        signal.aborted ||
        entry.closing ||
        connected.isClosed() ||
        entry.client !== connected.client ||
        entry.connectionGeneration !== connectionGeneration
      ) {
        throw new Error(`MCP server "${serverId}" connection changed during tool discovery`);
      }
      const snapshot = createToolSnapshot(
        serverId,
        definitions,
        this.bindingManagerId,
        connectionGeneration,
      );
      const connectedClient = connected.client;
      connectedClient.setNotificationHandler('notifications/tools/list_changed', async () => {
        if (
          this.connections.get(serverId) !== entry ||
          entry.client !== connectedClient ||
          entry.connectionGeneration !== connectionGeneration
        ) {
          return;
        }
        await this.refreshTools(serverId).catch((error) => {
          if (
            this.connections.get(serverId) !== entry ||
            entry.client !== connectedClient ||
            entry.connectionGeneration !== connectionGeneration
          ) {
            return;
          }
          // Discovery refresh failure does not mean the transport closed. Keep
          // the previous tool snapshot callable and avoid opening a second
          // client over a still-live connection.
          this.update(entry, {
            ...entry.status,
            error: errorMessage(error),
            updatedAt: this.now(),
          });
        });
      });
      this.replaceToolSnapshot(entry, snapshot.entries);
      this.update(entry, {
        serverId,
        state: 'connected',
        transport: connected.kind,
        toolCount: snapshot.descriptors.length,
        tools: snapshot.descriptors,
        stderrTail: entry.status.stderrTail,
        updatedAt: this.now(),
      });
      return cloneStatus(entry.status);
    } catch (error) {
      const exposedError = safeMcpOperationError(
        serverId,
        signal.aborted ? 'connection aborted' : 'connection failed',
        error,
        !signal.aborted,
      );
      await safeClose(connected?.client ?? entry.client, connected?.transport ?? entry.transport);
      if (!connected || !entry.client || entry.client === connected.client) {
        entry.client = undefined;
        entry.transport = undefined;
        entry.stdioTransport = undefined;
        this.replaceToolSnapshot(entry, new Map());
        entry.connectionGeneration = undefined;
        entry.refreshState = undefined;
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
      const client = this.createClient();
      const isClosed = this.watchClientClose(serverId, entry, client);
      try {
        await client.connect(transport, { timeout: this.timeouts.stdioConnectMs, signal });
        return { client, transport, stdioTransport: transport, kind: 'stdio', isClosed };
      } catch (error) {
        await safeClose(client, transport);
        throw enrichStdioError(error, entry.status.stderrTail);
      }
    }
    const remoteConfig = entry.config;
    const requested = remoteConfig.transport ?? 'auto';
    if (requested !== 'sse') {
      const client = this.createClient();
      const transport = new StreamableHTTPClientTransport(new URL(remoteConfig.url), {
        requestInit: { headers: remoteConfig.headers },
      });
      const isClosed = this.watchClientClose(serverId, entry, client);
      try {
        await client.connect(transport, { timeout: this.timeouts.remoteConnectMs, signal });
        return { client, transport, kind: 'streamable-http', isClosed };
      } catch (error) {
        await safeClose(client, transport);
        if (requested === 'streamable-http') throw error;
      }
    }
    const client = this.createClient();
    const transport = new SSEClientTransport(new URL(remoteConfig.url), {
      requestInit: { headers: remoteConfig.headers },
    });
    const isClosed = this.watchClientClose(serverId, entry, client);
    try {
      await client.connect(transport, { timeout: this.timeouts.remoteConnectMs, signal });
      return { client, transport, kind: 'sse', isClosed };
    } catch (error) {
      await safeClose(client, transport);
      throw error;
    }
  }

  private createClient(): Client {
    return new Client(
      { name: this.clientName, version: this.clientVersion },
      {
        capabilities: {},
        versionNegotiation: { mode: 'legacy' },
        enforceStrictCapabilities: false,
      },
    );
  }

  private async refreshToolLoop(
    serverId: string,
    entry: Connection,
    state: ToolRefreshState,
  ): Promise<McpToolDescriptor[]> {
    while (true) {
      state.pending = false;
      let definitions: McpDiscoveredTool[] | undefined;
      let failure: unknown;
      try {
        definitions = await listAllTools(state.client, serverId, this.timeouts.listToolsMs);
      } catch (error) {
        failure = error;
      }
      if (
        this.connections.get(serverId) !== entry ||
        entry.client !== state.client ||
        entry.connectionGeneration !== state.connectionGeneration ||
        entry.status.state !== 'connected'
      ) {
        throw safeMcpOperationError(serverId, 'connection changed during tool refresh', failure);
      }
      if (state.pending) continue;
      if (failure !== undefined) {
        throw safeMcpOperationError(serverId, 'tool refresh failed', failure);
      }
      if (!definitions) throw new Error(`MCP server "${serverId}" returned no tool definitions`);

      const snapshot = createToolSnapshot(
        serverId,
        definitions,
        this.bindingManagerId,
        state.connectionGeneration,
        entry.toolSnapshot,
      );
      this.replaceToolSnapshot(entry, snapshot.entries);
      this.update(entry, {
        ...entry.status,
        tools: snapshot.descriptors,
        toolCount: snapshot.descriptors.length,
        error: undefined,
        updatedAt: this.now(),
      });
      return snapshot.descriptors.map(cloneTool);
    }
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
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdioTransport = undefined;
    this.replaceToolSnapshot(entry, new Map());
    entry.connectionGeneration = undefined;
    entry.refreshState = undefined;
    this.update(entry, {
      ...entry.status,
      state: 'disconnected',
      toolCount: 0,
      tools: [],
      updatedAt: this.now(),
    });
  }

  private markError(entry: Connection, error: unknown): void {
    this.update(entry, {
      ...entry.status,
      state: 'error',
      error: errorMessage(error),
      updatedAt: this.now(),
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

function createToolSnapshot(
  serverId: string,
  definitions: readonly McpDiscoveredTool[],
  managerId: string,
  connectionGeneration: number,
  previousEntries?: ReadonlyMap<string, ToolSnapshotEntry>,
): { entries: Map<string, ToolSnapshotEntry>; descriptors: McpToolDescriptor[] } {
  const entries = new Map<string, ToolSnapshotEntry>();
  const descriptors: McpToolDescriptor[] = [];
  for (const discovered of definitions) {
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
      ...(previous?.connectionGeneration === connectionGeneration &&
      previous.definitionFingerprint === definitionFingerprint &&
      previous.callPreparation
        ? { callPreparation: previous.callPreparation }
        : {}),
    });
    descriptors.push(descriptor);
  }
  return { entries, descriptors };
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

async function safeClose(client?: Client, transport?: Transport): Promise<void> {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
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
  return { ...status, tools: status.tools.map(cloneTool), stderrTail: status.stderrTail?.slice() };
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
