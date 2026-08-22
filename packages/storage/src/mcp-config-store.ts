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

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  MCP_CONFIG_VERSION,
  createDefaultMcpConfig,
  isNonLoopbackCleartextHttp,
  type McpConfigFile,
  type McpOAuthConfig,
  type McpProtocolPreference,
  type McpRemoteServerConfig,
  type McpServerConfig,
  type McpStdioServerConfig,
} from '@maka/core/mcp';

const MAX_SERVERS = 100;
const MAX_ID_LENGTH = 128;
const MAX_STRING_LENGTH = 8_192;
const MAX_CONFIG_BYTES = 1_048_576;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export interface McpConfigStore {
  get(): Promise<McpConfigFile>;
  set(config: McpConfigFile): Promise<McpConfigFile>;
  /** One serialized read-transform-write. `apply` sees the CURRENT on-disk
   * config and returns the next one, inside the store's write queue — the
   * seam for restore-plus-mutation flows whose separate get()-then-write
   * would race a concurrent writer and roll a rotated secret back. */
  transform(apply: (current: McpConfigFile) => McpConfigFile): Promise<McpConfigFile>;
  upsert(serverId: string, config: McpServerConfig): Promise<McpConfigFile>;
  remove(serverId: string): Promise<McpConfigFile>;
}

/** Thrown by insert when the id is taken. Same-process callers (the IPC
 * layer) match on instanceof and answer the renderer with a typed
 * envelope; the message never has to carry a machine-readable code. */
export class McpServerExistsError extends Error {
  constructor(readonly serverId: string) {
    super(`MCP server "${serverId}" already exists`);
    this.name = 'McpServerExistsError';
  }
}

export function createMcpConfigStore(workspaceRoot: string): McpConfigStore {
  return new FileMcpConfigStore(join(workspaceRoot, 'mcp.json'));
}

export function normalizeMcpConfig(value: unknown): McpConfigFile {
  if (!isRecord(value)) throw new Error('MCP config must be an object');
  const sourceVersion = supportedSourceVersion(value);
  if (!isRecord(value.mcpServers)) throw new Error('mcpServers must be an object');
  const entries = Object.entries(value.mcpServers);
  if (entries.length > MAX_SERVERS) throw new Error(`mcpServers exceeds ${MAX_SERVERS} entries`);
  const mcpServers: Record<string, McpServerConfig> = Object.create(null);
  for (const [serverId, raw] of entries) {
    assertSafeKey(serverId, 'server id');
    mcpServers[serverId] = normalizeServer(
      raw,
      serverId,
      sourceVersion,
      value.version === undefined,
    );
  }
  return { version: MCP_CONFIG_VERSION, mcpServers: { ...mcpServers } };
}

class FileMcpConfigStore implements McpConfigStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(): Promise<McpConfigFile> {
    return this.serial(async () => this.readOrCreate());
  }

  async set(config: McpConfigFile): Promise<McpConfigFile> {
    const normalized = normalizeMcpConfig(config);
    return this.serial(async () => {
      await this.assertCurrentVersionCanBeReplaced();
      enforceEndpointPolicyOnChanges(await this.tryRead(), normalized);
      await this.write(normalized);
      return normalized;
    });
  }

  async transform(apply: (current: McpConfigFile) => McpConfigFile): Promise<McpConfigFile> {
    return this.serial(async () => {
      const current = await this.readOrCreate();
      const next = normalizeMcpConfig(apply(current));
      enforceEndpointPolicyOnChanges(current, next);
      await this.write(next);
      return next;
    });
  }

  async upsert(serverId: string, config: McpServerConfig): Promise<McpConfigFile> {
    assertSafeKey(serverId, 'server id');
    return this.serial(async () => {
      const current = await this.readOrCreate();
      const next = normalizeMcpConfig({
        version: MCP_CONFIG_VERSION,
        mcpServers: { ...current.mcpServers, [serverId]: config },
      });
      enforceEndpointPolicyOnChanges(current, next);
      await this.write(next);
      return next;
    });
  }

  async remove(serverId: string): Promise<McpConfigFile> {
    assertSafeKey(serverId, 'server id');
    return this.serial(async () => {
      const current = await this.readOrCreate();
      const { [serverId]: _removed, ...mcpServers } = current.mcpServers;
      const next: McpConfigFile = { version: MCP_CONFIG_VERSION, mcpServers };
      await this.write(next);
      return next;
    });
  }

  private async tryRead(): Promise<McpConfigFile | undefined> {
    try {
      return await this.readOrCreate();
    } catch {
      // A malformed file is recovered by full replacement; policy then
      // applies to every server in the replacement.
      return undefined;
    }
  }

  private async readOrCreate(): Promise<McpConfigFile> {
    try {
      const text = await readFile(this.path, 'utf8');
      if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES)
        throw new Error('MCP config exceeds 1 MiB');
      return normalizeMcpConfig(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const empty = createDefaultMcpConfig();
      await this.write(empty);
      return empty;
    }
  }

  private async write(config: McpConfigFile): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(dir, 0o700);
    const tempPath = join(dir, `.mcp-${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      if (process.platform !== 'win32') await chmod(tempPath, 0o600);
      await rename(tempPath, this.path);
      if (process.platform !== 'win32') await chmod(this.path, 0o600);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }

  private async assertCurrentVersionCanBeReplaced(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let current: unknown;
    try {
      current = JSON.parse(text);
    } catch {
      // Full replacement is the explicit recovery path for malformed files.
      return;
    }
    if (!isRecord(current)) return;
    // A client that does not understand a future wrapper must not erase it.
    // Reuse the normal read boundary so this guard advances with the schema.
    supportedSourceVersion(current);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/** Endpoint security policy, enforced at the WRITE boundary for new or
 * repointed endpoints only. Reads grandfather whatever earlier releases
 * accepted: a single legacy `http://` entry must not make the whole file —
 * and every other server in it — unreadable and unrepairable from the app.
 * The transport layer still refuses to CONNECT such an endpoint, so a
 * grandfathered entry surfaces as a per-server error, not a working
 * cleartext channel. */
export function assertMcpEndpointPolicy(server: McpServerConfig, serverId: string): void {
  if (!('url' in server)) return;
  const parsed = new URL(server.url);
  if (isNonLoopbackCleartextHttp(parsed)) {
    // A remote MCP endpoint carries bearer tokens and tool payloads.
    throw new Error(`${serverId}.url must use https for non-loopback hosts`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${serverId}.url must not contain embedded credentials; use headers instead`);
  }
}

function enforceEndpointPolicyOnChanges(
  previous: McpConfigFile | undefined,
  next: McpConfigFile,
): void {
  for (const [serverId, server] of Object.entries(next.mcpServers)) {
    if (!('url' in server)) continue;
    const before = previous?.mcpServers[serverId];
    const beforeUrl = before && 'url' in before ? before.url : undefined;
    // Enabling/disabling or editing headers on a grandfathered entry stays
    // possible; introducing or repointing an endpoint takes the policy.
    if (server.url !== beforeUrl) assertMcpEndpointPolicy(server, serverId);
  }
}

function normalizeServer(
  value: unknown,
  serverId: string,
  sourceVersion: 1 | typeof MCP_CONFIG_VERSION,
  versionMissing: boolean,
): McpServerConfig {
  if (!isRecord(value)) throw new Error(`MCP server "${serverId}" must be an object`);
  const hasProtocol = Object.hasOwn(value, 'protocol');
  if (sourceVersion === 1 && hasProtocol) {
    const source = versionMissing ? 'without a version' : 'version 1';
    throw new Error(`MCP config ${source} must not contain "protocol"`);
  }
  const enabled = value.enabled === undefined ? true : bool(value.enabled, `${serverId}.enabled`);
  if (typeof value.command === 'string') {
    if (hasProtocol) {
      throw new Error(`${serverId}.protocol is not supported for stdio in version 2`);
    }
    const result: McpStdioServerConfig = {
      enabled,
      command: nonEmptyString(value.command, `${serverId}.command`),
    };
    if (value.args !== undefined) result.args = stringArray(value.args, `${serverId}.args`);
    if (value.env !== undefined) result.env = stringMap(value.env, `${serverId}.env`);
    if (value.cwd !== undefined) result.cwd = nonEmptyString(value.cwd, `${serverId}.cwd`);
    return result;
  }
  const url = nonEmptyString(value.url, `${serverId}.url`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${serverId}.url must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${serverId}.url must use http or https`);
  }
  const transport = value.transport ?? 'auto';
  if (transport !== 'auto' && transport !== 'streamable-http' && transport !== 'sse') {
    throw new Error(`${serverId}.transport is invalid`);
  }
  const protocol = protocolPreference(value.protocol, `${serverId}.protocol`);
  if (transport === 'sse' && protocol !== undefined && protocol !== 'legacy') {
    throw new Error(`${serverId}.transport "sse" requires protocol "legacy"`);
  }
  const result: McpRemoteServerConfig = {
    enabled,
    url: parsed.toString(),
    transport,
  };
  if (value.headers !== undefined) result.headers = stringMap(value.headers, `${serverId}.headers`);
  if (protocol !== undefined) result.protocol = protocol;
  if (value.oauth !== undefined) result.oauth = normalizeOAuth(value.oauth, serverId);
  if (
    result.oauth &&
    Object.keys(result.headers ?? {}).some((key) => key.toLowerCase() === 'authorization')
  ) {
    // One authority per header: the OAuth bearer owns Authorization. A
    // config declaring both is a conflict to reject, not to arbitrate at
    // request time.
    throw new Error(`${serverId}.headers must not include Authorization when oauth is configured`);
  }
  return result;
}

function normalizeOAuth(value: unknown, serverId: string): McpOAuthConfig {
  if (!isRecord(value)) throw new Error(`${serverId}.oauth must be an object`);
  const result: McpOAuthConfig = {};
  if (value.clientId !== undefined) {
    result.clientId = nonEmptyString(value.clientId, `${serverId}.oauth.clientId`);
  }
  if (value.clientSecret !== undefined) {
    result.clientSecret = nonEmptyString(value.clientSecret, `${serverId}.oauth.clientSecret`);
  }
  if (result.clientSecret !== undefined && result.clientId === undefined) {
    // A secret with no client id cannot form static client credentials —
    // authentication would fail later, far from the config mistake.
    throw new Error(`${serverId}.oauth.clientId is required when clientSecret is configured`);
  }
  if (value.scopes !== undefined) {
    result.scopes = stringArray(value.scopes, `${serverId}.oauth.scopes`).map((scope, index) => {
      // RFC 6749 §3.3 scope-token: printable ASCII except space, quote and
      // backslash. The list joins space-delimited on the wire, so an entry
      // outside the grammar would silently change the requested grant or be
      // rejected as invalid_scope far from the config mistake.
      if (!/^[\x21\x23-\x5B\x5D-\x7E]+$/u.test(scope)) {
        throw new Error(`${serverId}.oauth.scopes[${index}] must be a non-empty scope token`);
      }
      return scope;
    });
  }
  if (value.callbackPort !== undefined) {
    if (
      typeof value.callbackPort !== 'number' ||
      !Number.isInteger(value.callbackPort) ||
      value.callbackPort < 1 ||
      value.callbackPort > 65_535
    ) {
      throw new Error(`${serverId}.oauth.callbackPort must be a port number`);
    }
    result.callbackPort = value.callbackPort;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function supportedSourceVersion(value: Record<string, unknown>): 1 | typeof MCP_CONFIG_VERSION {
  const sourceVersion = value.version === undefined ? 1 : value.version;
  if (sourceVersion !== 1 && sourceVersion !== MCP_CONFIG_VERSION) {
    throw new Error(`Unsupported MCP config version: ${String(value.version)}`);
  }
  return sourceVersion;
}

function assertSafeKey(value: string, label: string): void {
  if (!value.trim() || value.length > MAX_ID_LENGTH || FORBIDDEN_KEYS.has(value))
    throw new Error(`Invalid ${label}`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Invalid ${label}`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_STRING_LENGTH) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.includes('\0')) throw new Error(`${label} contains a NUL byte`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function protocolPreference(value: unknown, label: string): McpProtocolPreference | undefined {
  if (value === undefined) return undefined;
  if (value !== 'legacy' && value !== 'auto' && value !== '2026-07-28') {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.length > MAX_STRING_LENGTH || item.includes('\0')) {
      throw new Error(`${label}[${index}] must be a valid string`);
    }
    return item;
  });
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > 1_000)
    throw new Error(`${label} must be an object`);
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    assertSafeKey(key, `${label} key`);
    if (typeof item !== 'string' || item.length > MAX_STRING_LENGTH || item.includes('\0')) {
      throw new Error(`${label}.${key} must be a valid string`);
    }
    result[key] = item;
  }
  return { ...result };
}
