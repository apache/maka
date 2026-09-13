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

// apps/desktop/src/main/mcp-secret-guard.ts
//
// mcp.json carries credential material in several positions: a static
// OAuth clientSecret, remote request headers, remote URL query parameters
// (?api_key=…), stdio env values, and command-line arguments (--token …).
// The renderer is semi-trusted (SECURITY.md §3), so mcp:getConfig must not
// hand any of it over raw. Config leaves main with each such value
// replaced by a redaction marker; when the renderer sends an edited config
// back, markers are restored from what is on disk.
//
// The marker is occurrence-bound and non-confusable:
// - a per-process random nonce makes it impossible for a legitimate config
//   value to collide with it (a fixed public sentinel is itself a valid
//   string a user could enter);
// - a position tag (env key, header name, argument index, query key plus
//   occurrence index, oauth) binds each marker to the exact place it was
//   stamped, so a marker moved to another position — or a stale one from a
//   previous process — REJECTS the write instead of acting as a wildcard.
//
// Which positions are masked:
// - headers: every value — the field exists to carry credentials.
// - env: every value — key-name heuristics miss real secrets (PGPASSWORD,
//   DATABASE_URL, GITHUB_PAT), and the boundary is absolute; ordinary
//   values are cheap for the user to retype.
// - args / URL query: values a sensitive-named flag or parameter
//   introduces, plus anything the pattern redactor recognizes — free-form
//   positions where full masking would destroy the editor. Repeated query
//   keys mask and restore per occurrence, in order.
//
// Every restore is bound to the launch basis the value was configured
// for. A renderer that kept a marker but changed where the value flows —
// the URL for remote credentials; the command, arguments, cwd or any
// other env entry for stdio (each of those can redirect which executable
// runs or where it connects) — must not have main forward a secret it
// cannot read. An unrestorable marker REJECTS the write: silently dropping
// it would destroy stored values (and could leave an introducing flag
// consuming its neighbour) without the user ever learning why. The
// rejection message names the position, never the value.

import { randomBytes } from 'node:crypto';
import {
  listMcpSecretLocations,
  parseCommandFlag,
  type McpSecretLocation,
} from '@maka/core/mcp-secrets';
import {
  isMcpStdioConfig,
  MCP_CONFIG_VERSION,
  type McpConfigFile,
  type McpRemoteServerConfig,
  type McpServerConfig,
  type McpStdioServerConfig,
} from '@maka/core/mcp';

const MARKER_PREFIX = '__MAKA_MCP_SECRET_';
const MARKER_NONCE = randomBytes(6).toString('base64url');

/** The redaction marker for one exact position. Tests build expected
 * values with it; the renderer treats it as an opaque kept-value token. */
export function mcpSecretMarker(tag: string): string {
  return `${MARKER_PREFIX}${MARKER_NONCE}.${tag}__`;
}

/** Whether a value is shaped like a redaction marker at all — including a
 * displaced, hand-altered or previous-process one, which restore rejects. */
export function isMcpSecretMarkerLike(value: string): boolean {
  return value.startsWith(MARKER_PREFIX);
}

/** Thrown when an incoming config keeps a marker whose stored value can no
 * longer be restored — the launch basis changed, the marker was moved or is
 * stale, or there is nothing on disk behind it. The write is rejected so
 * the renderer can tell the user to re-enter the secret; the message never
 * carries a value. */
export class McpSecretRestoreError extends Error {
  constructor(serverId: string, position: string) {
    super(
      `MCP server "${serverId}": the masked ${position} cannot be restored because its ` +
        'configuration basis changed — re-enter the secret value',
    );
    this.name = 'McpSecretRestoreError';
  }
}

/** Replaces every stored credential value with its position-bound marker
 * for the renderer. */
export function redactMcpConfigSecrets(config: McpConfigFile): McpConfigFile {
  return mapServers(config, (server) => {
    if (isMcpStdioConfig(server)) return redactStdio(server);
    return redactRemote(server);
  });
}

/** Restores markers in an incoming config from the on-disk previous
 * config, so the renderer never has to hold the real values. */
export function restoreMcpConfigSecrets(
  incoming: McpConfigFile,
  previous: McpConfigFile,
): McpConfigFile {
  return mapServers(incoming, (server, serverId) => {
    const prior = Object.hasOwn(previous.mcpServers, serverId)
      ? previous.mcpServers[serverId]
      : undefined;
    if (isMcpStdioConfig(server)) return restoreStdio(serverId, server, prior);
    return restoreRemote(serverId, server, prior);
  });
}

/** Restores markers for a single upsert/insert config value. */
export function restoreMcpServerSecret(
  serverId: string,
  config: McpServerConfig,
  previous: McpConfigFile,
): McpServerConfig {
  const restored = restoreMcpConfigSecrets(
    { version: MCP_CONFIG_VERSION, mcpServers: { [serverId]: config } },
    previous,
  );
  return restored.mcpServers[serverId] ?? config;
}

// ---------------------------------------------------------------------------
// stdio

function redactStdio(server: McpStdioServerConfig): McpServerConfig {
  const locations = listMcpSecretLocations(server);
  const next: McpStdioServerConfig = { ...server };
  if (next.env) {
    // Every env value is masked regardless of the plan's credential split:
    // the plan's `credential` flag governs scrub aggressiveness, while the
    // IPC boundary is absolute for the whole map.
    next.env = mapValues(next.env, (key, value) =>
      value ? mcpSecretMarker(`env.${key}`) : value,
    );
  }
  if (next.args) {
    const argLocations = locations.filter(
      (location): location is McpSecretLocation & { index: number } =>
        (location.kind === 'arg' || location.kind === 'arg-flag-value') &&
        location.index !== undefined,
    );
    if (argLocations.length > 0) {
      const args = [...next.args];
      for (const location of argLocations) {
        args[location.index] =
          location.kind === 'arg-flag-value'
            ? `${location.key}=${mcpSecretMarker(`argflag.${location.index}`)}`
            : mcpSecretMarker(`arg.${location.index}`);
      }
      next.args = args;
    }
  }
  return next;
}

function restoreStdio(
  serverId: string,
  server: McpStdioServerConfig,
  prior: McpServerConfig | undefined,
): McpServerConfig {
  const priorStdio = prior && isMcpStdioConfig(prior) ? prior : undefined;
  const args = server.args ?? [];
  const priorArgs = priorStdio?.args ?? [];
  // The whole effective launch basis must match: command, cwd, the arg
  // list shape, the env key set, and every value the renderer DID rewrite.
  // Any deviation — a changed cwd, a new PATH, an extra flag — can point
  // the restored secrets at a different executable or destination, so no
  // marker may restore; the write rejects and the user re-enters the
  // secrets (or reverts the basis change).
  const sameBasis =
    priorStdio !== undefined &&
    priorStdio.command === server.command &&
    (priorStdio.cwd ?? '') === (server.cwd ?? '') &&
    args.length === priorArgs.length &&
    args.every((arg, index) => argMatchesPrior(arg, index, priorArgs[index] ?? '')) &&
    sameKeySet(server.env ?? {}, priorStdio.env ?? {}) &&
    Object.entries(server.env ?? {}).every(
      ([key, value]) => value === mcpSecretMarker(`env.${key}`) || priorStdio.env?.[key] === value,
    );

  const next: McpStdioServerConfig = { ...server };
  if (next.env) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(next.env)) {
      if (value === mcpSecretMarker(`env.${key}`)) {
        const priorValue = sameBasis ? priorStdio.env?.[key] : undefined;
        if (priorValue === undefined) {
          throw new McpSecretRestoreError(serverId, `environment value "${key}"`);
        }
        env[key] = priorValue;
        continue;
      }
      if (isMcpSecretMarkerLike(value)) {
        // Displaced, altered or stale marker: never a wildcard.
        throw new McpSecretRestoreError(serverId, `environment value "${key}"`);
      }
      env[key] = value;
    }
    next.env = env;
  }
  if (next.args) {
    next.args = next.args.map((arg, index) => {
      const restored = restoreArg(arg, index, sameBasis ? priorArgs[index] : undefined);
      if (restored === undefined) {
        // Dropping instead would leave the introducing flag consuming its
        // neighbour (`--token --verbose`); rejection keeps the command
        // line intact and the failure visible.
        throw new McpSecretRestoreError(serverId, `argument ${index + 1}`);
      }
      return restored;
    });
  }
  return next;
}

function argMatchesPrior(arg: string, index: number, priorArg: string): boolean {
  if (arg === mcpSecretMarker(`arg.${index}`)) return true;
  const flag = parseCommandFlag(arg);
  if (flag?.value === mcpSecretMarker(`argflag.${index}`)) {
    return priorArg.startsWith(`${flag.raw}=`);
  }
  return arg === priorArg;
}

function restoreArg(arg: string, index: number, priorArg: string | undefined): string | undefined {
  if (arg === mcpSecretMarker(`arg.${index}`)) return priorArg;
  const flag = parseCommandFlag(arg);
  if (flag?.value === mcpSecretMarker(`argflag.${index}`)) {
    return priorArg?.startsWith(`${flag.raw}=`) ? priorArg : undefined;
  }
  // Any other marker-shaped argument (moved, altered, stale) is
  // unrestorable by definition.
  if (isMcpSecretMarkerLike(arg) || (flag?.value !== undefined && isMcpSecretMarkerLike(flag.value))) {
    return undefined;
  }
  return arg;
}

// ---------------------------------------------------------------------------
// remote

function redactRemote(server: McpRemoteServerConfig): McpServerConfig {
  const locations = listMcpSecretLocations(server);
  const next: McpRemoteServerConfig = { ...server };
  next.url = maskUrlQuerySecrets(next.url, locations);
  if (next.headers) {
    next.headers = mapValues(next.headers, (key, value) =>
      value ? mcpSecretMarker(`header.${key}`) : value,
    );
  }
  if (next.oauth?.clientSecret) {
    next.oauth = { ...next.oauth, clientSecret: mcpSecretMarker('oauth') };
  }
  return next;
}

function restoreRemote(
  serverId: string,
  server: McpRemoteServerConfig,
  prior: McpServerConfig | undefined,
): McpServerConfig {
  const priorRemote = prior && !isMcpStdioConfig(prior) ? prior : undefined;
  const next: McpRemoteServerConfig = { ...server };
  next.url = restoreUrlQuerySecrets(serverId, next.url, priorRemote?.url);
  // Both sides parsed: restoreUrlQuerySecrets returns a WHATWG-normalized
  // string, so comparing against the raw stored URL would report a changed
  // endpoint for a merely unnormalized one (missing path slash) and reject
  // restores the user never invalidated.
  const sameEndpoint =
    priorRemote !== undefined && normalizeUrl(priorRemote.url) === normalizeUrl(next.url);
  if (next.headers) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(next.headers)) {
      if (value === mcpSecretMarker(`header.${key}`)) {
        const priorValue = sameEndpoint ? priorRemote.headers?.[key] : undefined;
        if (priorValue === undefined) {
          throw new McpSecretRestoreError(serverId, `header "${key}"`);
        }
        headers[key] = priorValue;
        continue;
      }
      if (isMcpSecretMarkerLike(value)) {
        throw new McpSecretRestoreError(serverId, `header "${key}"`);
      }
      headers[key] = value;
    }
    next.headers = headers;
  }
  if (next.oauth?.clientSecret !== undefined) {
    if (next.oauth.clientSecret === mcpSecretMarker('oauth')) {
      const priorSecret =
        sameEndpoint && priorRemote.oauth?.clientId === next.oauth.clientId
          ? priorRemote.oauth?.clientSecret
          : undefined;
      if (priorSecret === undefined) {
        throw new McpSecretRestoreError(serverId, 'oauth clientSecret');
      }
      next.oauth = { ...next.oauth, clientSecret: priorSecret };
    } else if (isMcpSecretMarkerLike(next.oauth.clientSecret)) {
      throw new McpSecretRestoreError(serverId, 'oauth clientSecret');
    }
  }
  return next;
}

/** Masks query parameter values that carry credentials — a sensitive-named
 * key (?api_key=…) or a pattern-recognized secret value. Repeated keys are
 * masked per occurrence, in order, so `?token=a&token=b` round-trips both
 * values instead of collapsing to one. */
function maskUrlQuerySecrets(url: string, locations: readonly McpSecretLocation[]): string {
  const parsed = parseUrl(url);
  if (!parsed) return url;
  const queryKeys = new Set(
    locations
      .filter((location) => location.kind === 'url-query')
      .map((location) => location.key)
      .filter((key): key is string => key !== undefined),
  );
  if (queryKeys.size === 0) return url;
  const occurrences = new Map<string, number>();
  const entries = [...parsed.searchParams.entries()].map(([key, value]) => {
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    if (!queryKeys.has(key) || !value) return [key, value] as const;
    return [key, mcpSecretMarker(`query.${key}.${occurrence}`)] as const;
  });
  parsed.search = buildSearch(entries);
  return parsed.toString();
}

/** Restores per-occurrence query markers from the prior URL — only when the
 * URL is otherwise identical position by position (origin, path, key order,
 * every unmasked value), so a repointed URL cannot inherit the secret. An
 * unrestorable or displaced marker rejects the write. */
function restoreUrlQuerySecrets(serverId: string, url: string, priorUrl: string | undefined): string {
  const parsed = parseUrl(url);
  if (!parsed) return url;
  const entries = [...parsed.searchParams.entries()];
  const occurrences = new Map<string, number>();
  const annotated = entries.map(([key, value]) => {
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const masked = value === mcpSecretMarker(`query.${key}.${occurrence}`);
    if (!masked && isMcpSecretMarkerLike(value)) {
      throw new McpSecretRestoreError(serverId, `URL query parameter "${key}"`);
    }
    return { key, value, occurrence, masked };
  });
  if (!annotated.some((entry) => entry.masked)) return parsed.toString();

  const prior = priorUrl ? parseUrl(priorUrl) : undefined;
  const priorEntries = prior ? [...prior.searchParams.entries()] : [];
  const sameRest =
    prior !== undefined &&
    prior.origin === parsed.origin &&
    prior.pathname === parsed.pathname &&
    prior.hash === parsed.hash &&
    priorEntries.length === annotated.length &&
    annotated.every(
      (entry, index) =>
        priorEntries[index]?.[0] === entry.key &&
        (entry.masked || priorEntries[index]?.[1] === entry.value),
    );
  const restored = annotated.map((entry, index) => {
    if (!entry.masked) return [entry.key, entry.value] as const;
    const priorValue = sameRest ? priorEntries[index]?.[1] : undefined;
    if (priorValue === undefined) {
      throw new McpSecretRestoreError(serverId, `URL query parameter "${entry.key}"`);
    }
    return [entry.key, priorValue] as const;
  });
  parsed.search = buildSearch(restored);
  return parsed.toString();
}

/** Serializes entries preserving order and duplicates. */
function buildSearch(entries: readonly (readonly [string, string])[]): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.append(key, value);
  return params.toString();
}

/** Canonical form for endpoint identity comparison; an unparsable URL falls
 * back to its raw text. The query is re-serialized through the SAME
 * serializer restore uses (URLSearchParams append), so a stored URL whose
 * raw encoding differs only cosmetically (%20 vs +) is not misclassified as
 * a changed endpoint — which would reject restores the user never
 * invalidated. */
function normalizeUrl(value: string): string {
  const parsed = parseUrl(value);
  if (!parsed) return value;
  parsed.search = buildSearch([...parsed.searchParams.entries()]);
  return parsed.toString();
}

// ---------------------------------------------------------------------------

function sameKeySet(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index]);
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function mapValues(
  record: Record<string, string>,
  transform: (key: string, value: string) => string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = transform(key, value);
  }
  return result;
}

function mapServers(
  config: McpConfigFile,
  transform: (server: McpServerConfig, serverId: string) => McpServerConfig,
): McpConfigFile {
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [serverId, server] of Object.entries(config.mcpServers)) {
    mcpServers[serverId] = transform(server, serverId);
  }
  return { ...config, mcpServers };
}
