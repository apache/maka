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
 * time — callers treat privately-RESOLVING names as accepted risk.
 *
 * IPv6 literals are classified by PARSED BYTES, not spelling: WHATWG URL
 * parsing canonicalizes hostnames (`[::ffff:127.0.0.1]` arrives here as
 * `[::ffff:7f00:1]`), so any spelling-based match is one canonicalization
 * away from missing an address it means to cover. IPv4-mapped (::ffff/96)
 * and NAT64 (64:ff9b::/96) embeddings classify by their embedded IPv4 —
 * INCLUDING 127/8, which `isLoopbackHost` deliberately does not learn:
 * there, an unrecognized spelling must stay "not loopback" so cleartext is
 * refused (fail closed); here it must stay "private" so the SSRF gate
 * blocks it (also fail closed) — the two defaults point in opposite
 * directions on purpose. A bracketed literal that does not parse at all is
 * therefore treated as private. */
export function isPrivateRangeHost(hostname: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (v4) {
    return isPrivateIpv4(Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4]));
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const bytes = parseIpv6(hostname.slice(1, -1));
    if (!bytes) return true;
    return classifyIpv6(bytes) === 'private';
  }
  return false;
}

function isPrivateIpv4(a: number, b: number, c: number, d: number): boolean {
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Exactly the unspecified address: connecting to 0.0.0.0 reaches the
  // LOCAL machine on common stacks (`https://0/` canonicalizes to it), so
  // it fails closed — but only the exact address: 0.0.0.1 does not reach a
  // local listener, and widening to 0.0.0.0/8 would grow the private set
  // without buying anything.
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  return false;
}

/** Minimal RFC 4291 text-representation parser: enough to turn any spelling
 * of an address into its 16 bytes so the classifier never depends on how a
 * caller (or the URL canonicalizer) chose to write it. Returns undefined
 * for anything that is not a well-formed address. */
function parseIpv6(literal: string): Uint8Array | undefined {
  const zone = literal.indexOf('%');
  // An empty zone id ('fe80::1%') is not a valid literal; rejecting it
  // keeps the documented fail-closed default honest.
  if (zone !== -1 && zone === literal.length - 1) return undefined;
  const text = (zone === -1 ? literal : literal.slice(0, zone)).toLowerCase();
  const gap = text.indexOf('::');
  if (gap !== -1 && text.indexOf('::', gap + 1) !== -1) return undefined;
  const parseGroups = (part: string, dottedAllowedAtEnd: boolean): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index] ?? '';
      if (piece.includes('.')) {
        // RFC 4291 §2.2: dotted IPv4 only in the low-order 32 bits — the
        // FINAL piece. '[192.168.1.1::]' must fail, not parse shifted.
        if (!dottedAllowedAtEnd || index !== pieces.length - 1) return undefined;
        const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(piece);
        if (!dotted) return undefined;
        const octets = dotted.slice(1).map(Number);
        if (octets.some((octet) => octet > 255)) return undefined;
        out.push(
          ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
          ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
        );
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(piece)) return undefined;
        out.push(Number.parseInt(piece, 16));
      }
    }
    return out;
  };
  let groups: number[] | undefined;
  if (gap === -1) {
    groups = parseGroups(text, true);
    if (!groups || groups.length !== 8) return undefined;
  } else {
    // Dotted IPv4 can only close the address, so only the tail may carry it.
    const head = parseGroups(text.slice(0, gap), false);
    const tail = parseGroups(text.slice(gap + 2), true);
    if (!head || !tail || head.length + tail.length > 7) return undefined;
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[2 * index] = group >> 8;
    bytes[2 * index + 1] = group & 0xff;
  });
  return bytes;
}

function classifyIpv6(bytes: Uint8Array): 'loopback' | 'private' | 'global' {
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return 'loopback';
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const nat64 =
    bytes[0] === 0 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  // RFC 8215 local-use NAT64 space (64:ff9b:1::/48) is reserved for
  // translation inside one network — by definition never a global
  // destination. Deployments carve arbitrary RFC 6052 prefix lengths out
  // of it, so the embedded IPv4's position is not recoverable here; the
  // whole /48 fails closed instead.
  if (
    bytes[0] === 0 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0 &&
    bytes[5] === 1
  ) {
    return 'private';
  }
  // The remaining byte-level IPv4 embeddings, classified by the embedded
  // address: deprecated IPv4-compatible ::/96 (RFC 4291 §2.5.5.1) and the
  // RFC 2765 SIIT prefix ::ffff:0:0/96. Deprecated is not absent — the
  // classifier's whole premise is bytes over spellings, and whether the
  // OTHER end's stack still translates these must not be what the gate's
  // correctness rests on. `::1` was returned above.
  const compat = bytes.slice(0, 12).every((byte) => byte === 0);
  const siit =
    bytes.slice(0, 8).every((byte) => byte === 0) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0 &&
    bytes[11] === 0;
  if (mapped || nat64 || compat || siit) {
    const [a, b, c, d] = [bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0];
    // Mapped loopback lands on the PRIVATE side of the gate: isLoopbackHost
    // stays strict-by-spelling, so this is the check that must catch it.
    // The embedded unspecified address (0.0.0.0 — reaches the local
    // machine on common stacks) is private via isPrivateIpv4.
    if (a === 127) return 'private';
    return isPrivateIpv4(a, b, c, d) ? 'private' : 'global';
  }
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return 'private'; // fc00::/7 (ULA)
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return 'private'; // fe80::/10
  return 'global';
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
