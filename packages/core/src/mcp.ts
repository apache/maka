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

export const MCP_CONFIG_VERSION = 2 as const;

export type McpTransportKind = 'stdio' | 'streamable-http' | 'sse' | 'auto';

export type McpProtocolPreference = 'legacy' | 'auto' | '2026-07-28';

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
  protocol?: McpProtocolPreference;
  oauth?: McpOAuthConfig;
}

/**
 * Static OAuth client settings for servers whose authorization server does
 * not support dynamic registration (RFC 7591) or CIMD. All fields are
 * optional: with none set, the client registers dynamically and listens on
 * an ephemeral loopback port. A pre-registered client usually pins
 * `callbackPort`, because its redirect URI was registered with a fixed port.
 */
export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  callbackPort?: number;
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface McpConfigFile {
  version: typeof MCP_CONFIG_VERSION;
  mcpServers: Record<string, McpServerConfig>;
}

/** The one definition of "traffic that never leaves this machine" — the
 * only place cleartext http is acceptable for MCP endpoints, OAuth
 * endpoints, and redirect hops. Storage validation, the runtime's fetch
 * guard, the desktop OAuth controller and the editor's field validation
 * all share it so the rule cannot drift. */
export function isLoopbackHost(hostname: string): boolean {
  // Only names whose loopback-ness the RUNTIME guarantees: `localhost` and
  // the literal loopback addresses. `*.localhost` is loopback per RFC 6761
  // §6.3, but Node hands it to the system resolver — under an attacker's
  // resolver (or hosts file) the name can point anywhere, and everything
  // built on this predicate (cleartext trust, provenance roots) would
  // follow it off the machine.
  return (
    hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

/** Private-range and link-local IP LITERALS (RFC 1918, RFC 3927/4291,
 * CGNAT). Hostname-based checks are deliberately out of scope: they would
 * need a resolve here and could still re-resolve differently at request
 * time — callers treat privately-RESOLVING names as accepted risk. */
export function isPrivateRangeHost(hostname: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (hostname.startsWith('[')) {
    const inner = hostname.slice(1, -1).toLowerCase();
    return inner.startsWith('fc') || inner.startsWith('fd') || inner.startsWith('fe8');
  }
  return false;
}

/** The composed rule the config store enforces, the runtime's fetch guard
 * re-checks per hop, and the editor mirrors onto the URL field: cleartext
 * http is only acceptable where it never leaves the machine. One
 * definition, so the three sites cannot drift. */
export function isNonLoopbackCleartextHttp(url: URL): boolean {
  return url.protocol === 'http:' && !isLoopbackHost(url.hostname);
}

/** Result of adding a new server. A taken id is an expected dialog outcome,
 * so it travels as data the renderer can switch on rather than as prose
 * fished out of a flattened IPC error string. */
export type McpConfigAddResult = { status: 'added'; config: McpConfigFile } | { status: 'exists' };

export type McpConnectionState =
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'needs-auth'
  | 'error';

export interface McpNegotiatedProtocol {
  era: 'legacy' | 'modern';
  revision: string;
}

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
  negotiatedProtocol?: McpNegotiatedProtocol;
  toolCount: number;
  tools: McpToolDescriptor[];
  error?: string;
  stderrTail?: string[];
  /** True when the connection is backed by stored OAuth credentials —
   * the UI offers logout only where there is something to drop. */
  authenticated?: boolean;
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

export function resolveMcpRemoteProtocolPreference(
  config: McpRemoteServerConfig,
): McpProtocolPreference {
  return config.protocol ?? 'legacy';
}

export function createDefaultMcpConfig(): McpConfigFile {
  return { version: MCP_CONFIG_VERSION, mcpServers: {} };
}
