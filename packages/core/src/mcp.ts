export const MCP_CONFIG_VERSION = 1 as const;

export type McpTransportKind = 'stdio' | 'streamable-http' | 'sse' | 'auto';

export interface McpStdioServerConfig {
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpRemoteServerConfig {
  enabled?: boolean;
  url: string;
  transport?: 'streamable-http' | 'sse' | 'auto';
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface McpConfigFile {
  version: typeof MCP_CONFIG_VERSION;
  mcpServers: Record<string, McpServerConfig>;
}

export type McpConnectionState = 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDescriptor {
  serverId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

declare const mcpToolBindingBrand: unique symbol;

/**
 * Opaque consistency handle for one tool definition in one provider-owned
 * snapshot. It prevents stale-definition calls; it is not a permission
 * capability. Consumers may retain and return it, but only the owning provider
 * can interpret or mint it.
 */
export type McpToolBinding = string & { readonly [mcpToolBindingBrand]: true };

export interface McpBoundTool {
  readonly descriptor: McpToolDescriptor;
  readonly binding: McpToolBinding;
}

/** One immutable, provider-owned view of every currently callable MCP tool. */
export interface McpToolSnapshot {
  readonly revision: number;
  readonly tools: readonly McpBoundTool[];
}

export interface McpServerStatus {
  serverId: string;
  state: McpConnectionState;
  transport?: Exclude<McpTransportKind, 'auto'>;
  toolCount: number;
  tools: McpToolDescriptor[];
  error?: string;
  stderrTail?: string[];
  updatedAt: number;
}

export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string; blob?: string }
  | { type: 'resource_link'; uri: string; name?: string; description?: string; mimeType?: string }
  | { type: 'unknown'; value: unknown };

export interface McpCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
}

export interface McpTestResult {
  ok: boolean;
  status: McpServerStatus;
  latencyMs: number;
}

export function isMcpStdioConfig(config: McpServerConfig): config is McpStdioServerConfig {
  return 'command' in config;
}

export function createDefaultMcpConfig(): McpConfigFile {
  return { version: MCP_CONFIG_VERSION, mcpServers: {} };
}
