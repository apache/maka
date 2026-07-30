import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { isDeepStrictEqual } from 'node:util';
import { redactSecrets } from '@maka/core/redaction';
import {
  isMcpStdioConfig,
  type McpCallResult,
  type McpConfigFile,
  type McpContentBlock,
  type McpServerConfig,
  type McpServerStatus,
  type McpTestResult,
  type McpToolDescriptor,
} from '@maka/core/mcp';
import {
  formatMcpHeaderExclusionWarning,
  partitionMcpHeaderToolDefinitions,
  validateMcpHeaderArguments,
  type McpHeaderDeclaration,
} from './sep-2243.js';
import { discoverMcpTools } from './tool-discovery.js';

const DEFAULT_TIMEOUTS = {
  remoteConnectMs: 30_000,
  stdioConnectMs: 60_000,
  listToolsMs: 15_000,
  callToolMs: 600_000,
} as const;
const STDERR_LINES = 10;
const STDERR_LINE_CHARS = 2_000;

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
  descriptor: McpToolDescriptor;
  headerDeclarations: readonly McpHeaderDeclaration[];
}

interface ToolRefreshState {
  readonly client: Client;
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
  enforceMcpHeaders: boolean;
  refreshState?: ToolRefreshState;
  closing: boolean;
}

export class McpToolCallError extends Error {
  readonly serverId: string;
  readonly toolName: string;

  constructor(serverId: string, toolName: string, message: string, options?: ErrorOptions) {
    super(`MCP ${serverId}/${toolName}: ${message}`, options);
    this.name = 'McpToolCallError';
    this.serverId = serverId;
    this.toolName = toolName;
  }
}

export class McpClientManager {
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<McpManagerChangeListener>();
  private syncQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly timeouts: McpTimeouts;
  private readonly now: () => number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly excludedStdioEnvironmentKeys: readonly string[];
  private toolSnapshotRevisionValue = 0;

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

  tools(): McpToolDescriptor[] {
    return this.statuses()
      .filter((status) => status.state === 'connected')
      .flatMap((status) => status.tools);
  }

  /** Revision of the callable MCP tool bindings, excluding status-only changes. */
  toolSnapshotRevision(): number {
    return this.toolSnapshotRevisionValue;
  }

  bindTool(serverId: string, toolName: string) {
    const entry = this.requireConnection(serverId);
    const client = entry.client;
    if (!client || entry.status.state !== 'connected') {
      throw new McpToolCallError(serverId, toolName, 'connection generation is unavailable');
    }
    return (
      args: Record<string, unknown>,
      options: { signal?: AbortSignal; timeoutMs?: number } = {},
    ): Promise<McpCallResult> =>
      this.callBoundTool(entry, client, serverId, toolName, args, options);
  }

  async connect(serverId: string): Promise<McpServerStatus> {
    const entry = this.requireConnection(serverId);
    if (entry.config.enabled === false) return cloneStatus(entry.status);
    if (entry.status.state === 'connected') return cloneStatus(entry.status);
    if (entry.connectPromise) return entry.connectPromise;
    const controller = new AbortController();
    entry.connectController = controller;
    entry.connectPromise = this.connectEntry(serverId, entry, controller.signal).finally(() => {
      entry.connectPromise = undefined;
      if (entry.connectController === controller) entry.connectController = undefined;
    });
    return entry.connectPromise;
  }

  cancelConnect(serverId: string): boolean {
    const controller = this.connections.get(serverId)?.connectController;
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
    const hadCallableTools = entry.status.state === 'connected' && entry.status.tools.length > 0;
    entry.closing = true;
    entry.connectController?.abort(new Error(`MCP connection closed: ${serverId}`));
    await entry.connectPromise?.catch(() => {});
    await safeClose(entry.client, entry.transport);
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdioTransport = undefined;
    entry.connectPromise = undefined;
    entry.toolSnapshot.clear();
    entry.enforceMcpHeaders = false;
    entry.refreshState = undefined;
    if (hadCallableTools) this.toolSnapshotRevisionValue += 1;
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
    await this.syncQueue.catch(() => {});
    await Promise.all(
      [...this.connections.keys()].map((serverId) => this.disconnect(serverId, true)),
    );
  }

  async refreshTools(serverId: string): Promise<McpToolDescriptor[]> {
    const entry = this.requireConnection(serverId);
    if (!entry.client || entry.status.state !== 'connected') await this.connect(serverId);
    const client = entry.client;
    if (!client) throw new Error(`MCP server "${serverId}" is not connected`);
    if (entry.refreshState?.client === client) {
      entry.refreshState.pending = true;
      return entry.refreshState.promise;
    }

    const state: ToolRefreshState = {
      client,
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
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    const entry = this.requireConnection(serverId);
    if (!entry.client || entry.status.state !== 'connected') await this.connect(serverId);
    if (!entry.client) throw new Error(`MCP server "${serverId}" is not connected`);
    return this.callBoundTool(entry, entry.client, serverId, toolName, args, options);
  }

  private async callBoundTool(
    entry: Connection,
    client: Client,
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<McpCallResult> {
    if (
      this.connections.get(serverId) !== entry ||
      entry.closing ||
      entry.client !== client ||
      entry.status.state !== 'connected'
    ) {
      throw new McpToolCallError(
        serverId,
        toolName,
        'connection generation is no longer available',
      );
    }
    const snapshot = entry.toolSnapshot.get(toolName);
    if (!snapshot) {
      throw new McpToolCallError(serverId, toolName, 'tool is not in the current snapshot');
    }
    if (entry.enforceMcpHeaders) {
      const validation = validateMcpHeaderArguments(snapshot.headerDeclarations, args);
      if (!validation.valid) {
        throw new McpToolCallError(
          serverId,
          toolName,
          `unsafe integer argument at ${validation.path.join('.')}`,
        );
      }
    }
    let result;
    try {
      result = await client.callTool(
        { name: toolName, arguments: args },
        {
          signal: options.signal,
          timeout: options.timeoutMs ?? this.timeouts.callToolMs,
          toolDefinition: snapshot.definition,
        },
      );
    } catch (error) {
      throw normalizeToolCallError(serverId, toolName, error, options.signal);
    }
    if (!('content' in result)) {
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
    entry.closing = false;
    this.update(entry, {
      ...entry.status,
      state: 'connecting',
      error: undefined,
      updatedAt: this.now(),
    });
    try {
      const connected = await this.openClient(serverId, entry, signal);
      entry.client = connected.client;
      entry.transport = connected.transport;
      entry.stdioTransport = connected.stdioTransport;
      const enforceMcpHeaders =
        connected.kind === 'streamable-http' && connected.client.getProtocolEra() === 'modern';
      const definitions = await listAllTools(connected.client, serverId, this.timeouts.listToolsMs);
      const snapshot = createToolSnapshot(serverId, definitions, enforceMcpHeaders);
      connected.client.setNotificationHandler('notifications/tools/list_changed', async () => {
        if (this.connections.get(serverId) !== entry || entry.client !== connected.client) return;
        await this.refreshTools(serverId).catch((error) => {
          if (this.connections.get(serverId) !== entry || entry.client !== connected.client) return;
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
      entry.toolSnapshot = snapshot.entries;
      entry.enforceMcpHeaders = enforceMcpHeaders;
      if (snapshot.descriptors.length > 0) this.toolSnapshotRevisionValue += 1;
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
      await safeClose(entry.client, entry.transport);
      entry.client = undefined;
      entry.transport = undefined;
      entry.stdioTransport = undefined;
      entry.toolSnapshot.clear();
      entry.enforceMcpHeaders = false;
      entry.refreshState = undefined;
      if (!signal.aborted) this.markError(entry, error);
      throw error;
    }
  }

  private async openClient(
    serverId: string,
    entry: Connection,
    signal: AbortSignal,
  ): Promise<{
    client: Client;
    transport: Transport;
    stdioTransport?: StdioClientTransport;
    kind: 'stdio' | 'streamable-http' | 'sse';
  }> {
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
      client.onclose = () => this.handleTransportClose(entry);
      try {
        await client.connect(transport, { timeout: this.timeouts.stdioConnectMs, signal });
        return { client, transport, stdioTransport: transport, kind: 'stdio' };
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
      client.onclose = () => this.handleTransportClose(entry);
      try {
        await client.connect(transport, { timeout: this.timeouts.remoteConnectMs, signal });
        return { client, transport, kind: 'streamable-http' };
      } catch (error) {
        await safeClose(client, transport);
        if (requested === 'streamable-http') throw error;
      }
    }
    const client = this.createClient();
    const transport = new SSEClientTransport(new URL(remoteConfig.url), {
      requestInit: { headers: remoteConfig.headers },
    });
    client.onclose = () => this.handleTransportClose(entry);
    try {
      await client.connect(transport, { timeout: this.timeouts.remoteConnectMs, signal });
      return { client, transport, kind: 'sse' };
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
      let definitions: Tool[] | undefined;
      let failure: unknown;
      try {
        definitions = await listAllTools(state.client, serverId, this.timeouts.listToolsMs);
      } catch (error) {
        failure = error;
      }
      if (
        this.connections.get(serverId) !== entry ||
        entry.client !== state.client ||
        entry.status.state !== 'connected'
      ) {
        throw new Error(`MCP server "${serverId}" connection changed during tool refresh`, {
          cause: failure,
        });
      }
      if (state.pending) continue;
      if (failure !== undefined) throw failure;
      if (!definitions) throw new Error(`MCP server "${serverId}" returned no tool definitions`);

      const snapshot = createToolSnapshot(serverId, definitions, entry.enforceMcpHeaders);
      if (!isDeepStrictEqual(entry.status.tools, snapshot.descriptors)) {
        this.toolSnapshotRevisionValue += 1;
      }
      entry.toolSnapshot = snapshot.entries;
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

  private handleTransportClose(entry: Connection): void {
    if (entry.closing) return;
    if (entry.status.state === 'connected' && entry.status.tools.length > 0) {
      this.toolSnapshotRevisionValue += 1;
    }
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdioTransport = undefined;
    entry.toolSnapshot.clear();
    entry.enforceMcpHeaders = false;
    entry.refreshState = undefined;
    this.update(entry, { ...entry.status, state: 'disconnected', updatedAt: this.now() });
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

  private makeStatus(serverId: string, state: McpServerStatus['state']): McpServerStatus {
    return { serverId, state, toolCount: 0, tools: [], updatedAt: this.now() };
  }
}

async function listAllTools(client: Client, serverId: string, timeout: number): Promise<Tool[]> {
  return discoverMcpTools(
    {
      requestToolsPage: (cursor, timeoutMs) =>
        client.request(
          {
            method: 'tools/list',
            ...(cursor !== undefined ? { params: { cursor } } : {}),
          },
          { timeout: timeoutMs },
        ),
    },
    serverId,
    timeout,
  );
}

function createToolSnapshot(
  serverId: string,
  definitions: readonly Tool[],
  enforceMcpHeaders: boolean,
): { entries: Map<string, ToolSnapshotEntry>; descriptors: McpToolDescriptor[] } {
  const partition = enforceMcpHeaders
    ? partitionMcpHeaderToolDefinitions(definitions)
    : {
        valid: definitions.map((tool) => ({ tool, declarations: [] })),
        rejected: [],
      };
  const warning = formatMcpHeaderExclusionWarning(partition.rejected);
  if (warning) console.warn(warning);

  const entries = new Map<string, ToolSnapshotEntry>();
  const descriptors: McpToolDescriptor[] = [];
  for (const { tool, declarations } of partition.valid) {
    const definition = structuredClone(tool);
    const descriptor = descriptorFromTool(serverId, definition);
    entries.set(definition.name, {
      definition,
      descriptor,
      headerDeclarations: declarations.map((declaration) => ({
        ...declaration,
        path: [...declaration.path],
      })),
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
  const text = content
    .map((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || 'server reported an error';
}

function normalizeToolCallError(
  serverId: string,
  toolName: string,
  error: unknown,
  signal?: AbortSignal,
): Error {
  if (error instanceof McpToolCallError) return error;
  if (signal?.aborted) {
    return new McpToolCallError(serverId, toolName, 'tool call aborted', { cause: error });
  }
  if (error instanceof SdkError) {
    switch (error.code) {
      case SdkErrorCode.RequestTimeout:
        return new McpToolCallError(serverId, toolName, 'tool call timed out', { cause: error });
      case SdkErrorCode.InvalidResult:
        return new McpToolCallError(serverId, toolName, 'server returned an invalid tool result', {
          cause: error,
        });
      case SdkErrorCode.UnsupportedResultType:
        return new McpToolCallError(
          serverId,
          toolName,
          'server returned an unsupported deferred tool result',
          { cause: error },
        );
      default:
        return new McpToolCallError(serverId, toolName, 'tool call failed', { cause: error });
    }
  }
  if (error instanceof ProtocolError) {
    return new McpToolCallError(
      serverId,
      toolName,
      'server rejected the tool call or returned an invalid result',
      { cause: error },
    );
  }
  return error instanceof Error
    ? error
    : new McpToolCallError(serverId, toolName, 'tool call failed', { cause: error });
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
  const append = (lines: string[]) => {
    const next = [...(entry.status.stderrTail ?? []), ...lines.map(sanitizeDiagnosticLine)]
      .filter(Boolean)
      .slice(-STDERR_LINES);
    entry.status = { ...entry.status, stderrTail: next, updatedAt: Date.now() };
    onUpdate();
  };
  const stream = transport.stderr;
  stream?.on('data', (chunk) => {
    pending += String(chunk);
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? '';
    append(lines);
    while (pending.length > STDERR_LINE_CHARS) {
      append([pending.slice(0, STDERR_LINE_CHARS)]);
      pending = pending.slice(STDERR_LINE_CHARS);
    }
  });
  const flush = () => {
    if (!pending) return;
    append([pending]);
    pending = '';
  };
  stream?.once('end', flush);
  stream?.once('close', flush);
}

function sanitizeDiagnosticLine(value: string): string {
  return redactSecrets(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .slice(0, STDERR_LINE_CHARS);
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

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
