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

// packages/core/src/mcp-secrets.ts
//
// The single authority for WHERE credential material lives in an MCP server
// config and WHICH values must never leave the main process in cleartext.
// Two consumers derive from the same plan so they cannot drift:
//
// - the desktop IPC boundary (mcp-secret-guard) masks exactly these
//   locations before a config crosses toward the renderer;
// - the runtime scrubber (packages/mcp) collects exactly these values to
//   scrub every outbound error, status, stderr and tool payload.
//
// The plan enumerates locations; masking mechanics (sentinels, restore
// binding) stay with the IPC guard, and scrubbing mechanics (substitution,
// withholding) stay here as shared primitives.

import { isSensitiveKey, redactSecrets } from './redaction.js';
import { isMcpStdioConfig, type McpServerConfig } from './mcp.js';

/** One credential-bearing position in a server config. */
export interface McpSecretLocation {
  /** Structural position — the IPC guard masks by this. */
  kind: 'header' | 'oauth-client-secret' | 'env' | 'arg' | 'arg-flag-value' | 'url-query';
  /** Header name / env key / query parameter, where applicable. */
  key?: string;
  /** Argument index, for arg kinds. */
  index?: number;
  /** The secret value itself. */
  value: string;
  /**
   * Credential-position values (headers, clientSecret, sensitive-keyed env,
   * flagged args, sensitive query params) are protected at any length; a
   * plain env value is ordinary configuration unless long enough to be an
   * unambiguous match.
   */
  credential: boolean;
}

/** Below this length a value cannot be spliced out of prose without
 * shredding it (replacing every "ab" would mangle ordinary messages), and a
 * plain configuration value this short is not a usable secret either. */
export const MCP_SECRET_MIN_SUBSTITUTION_LENGTH = 4;

export const MCP_SECRET_WITHHELD_MESSAGE =
  'message withheld: the upstream text contained credential material';

/** What the scrubber does with each value: long-enough values are
 * substituted in place; a WHOLE credential too short to splice out forces
 * the containing message to be withheld; a short FRAGMENT of a longer
 * credential ("Bearer x" → "x") is substituted only at token boundaries —
 * an upstream reflecting the bare fragment still loses it, without every
 * message containing that character collapsing. */
export interface McpSecretInventory {
  substitute: string[];
  /** Short credential fragments, replaced only as standalone tokens. */
  substituteBounded?: string[];
  withhold: string[];
}

export const EMPTY_MCP_SECRET_INVENTORY: McpSecretInventory = Object.freeze({
  substitute: [],
  substituteBounded: [],
  withhold: [],
});

/** Whether a command-line flag introduces a credential value (`--token x`,
 * `--api-key=x`). Shared so the guard's masking and any future consumer
 * agree on what counts. */
export function isSensitiveFlagName(name: string): boolean {
  return isSensitiveKey(name);
}

/** Whether a standalone value looks like a secret to the pattern redactor —
 * the only signal available for free-form positions (args, query values). */
export function isPatternSecret(value: string): boolean {
  return value.length > 0 && redactSecrets(value) !== value;
}

const FLAG_PATTERN = /^(--?[A-Za-z][\w-]*)(?:=([\s\S]*))?$/u;

export function parseCommandFlag(
  arg: string,
): { raw: string; name: string; value?: string } | undefined {
  const match = FLAG_PATTERN.exec(arg);
  if (!match) return undefined;
  const raw = match[1] ?? arg;
  return {
    raw,
    name: raw.replace(/^--?/u, ''),
    ...(match[2] !== undefined ? { value: match[2] } : {}),
  };
}

/** Enumerates every credential-bearing location in a server config — the
 * shared secret-location plan. */
export function listMcpSecretLocations(config: McpServerConfig): McpSecretLocation[] {
  const locations: McpSecretLocation[] = [];
  if (isMcpStdioConfig(config)) {
    for (const [key, value] of Object.entries(config.env ?? {})) {
      if (!value) continue;
      // Every env value is masked at the IPC boundary (key-name heuristics
      // miss real secrets — PGPASSWORD, DATABASE_URL); only sensitive-keyed
      // values are credential-position for scrubbing, because withholding
      // messages over NODE_ENV=1 would swallow nearly everything.
      locations.push({ kind: 'env', key, value, credential: isSensitiveKey(key) });
    }
    const args = config.args ?? [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? '';
      const previous = index > 0 ? (args[index - 1] ?? '') : '';
      const previousFlag = parseCommandFlag(previous);
      const flag = parseCommandFlag(arg);
      if (
        previousFlag &&
        previousFlag.value === undefined &&
        isSensitiveFlagName(previousFlag.name) &&
        // `--token --verbose` is a flag pair, not a flag and its secret:
        // classifying the second flag as credential material would hide it
        // from the editor and change the launched command.
        !flag
      ) {
        locations.push({ kind: 'arg', index, value: arg, credential: true });
        continue;
      }
      // A sensitive flag NAME marks its value; but a value that itself looks
      // like a token is a secret behind any name — `--custom=sk-…` must not
      // slip through because "custom" sounds harmless. The flag name is an
      // additional signal, never an exclusion.
      if (
        flag?.value !== undefined &&
        (isSensitiveFlagName(flag.name) || isPatternSecret(flag.value))
      ) {
        locations.push({
          kind: 'arg-flag-value',
          index,
          key: flag.raw,
          value: flag.value,
          credential: true,
        });
        continue;
      }
      if (!flag && isPatternSecret(arg)) {
        locations.push({ kind: 'arg', index, value: arg, credential: true });
      }
    }
    return locations;
  }
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    if (!value) continue;
    // The headers field exists to carry credentials: every value counts.
    locations.push({ kind: 'header', key, value, credential: true });
  }
  if (config.oauth?.clientSecret) {
    locations.push({
      kind: 'oauth-client-secret',
      value: config.oauth.clientSecret,
      credential: true,
    });
  }
  const url = parseUrl(config.url);
  if (url) {
    for (const [key, value] of url.searchParams.entries()) {
      if (value && (isSensitiveKey(key) || isPatternSecret(value))) {
        locations.push({ kind: 'url-query', key, value, credential: true });
      }
    }
  }
  return locations;
}

/** Builds the scrub inventory from the shared location plan. A whole value
 * short enough to be un-spliceable forces withholding when it sits in a
 * credential position; whitespace-separated PARTS of a longer value are
 * substituted when long enough (a reflected token loses its "Bearer" prefix
 * and still matches) but never withheld — a one-character part like the "x"
 * of "Bearer x" would otherwise collapse every message containing that
 * letter, and the full-value substitution already covers realistic
 * reflections. */
export function mcpSecretInventory(config: McpServerConfig): McpSecretInventory {
  const inventory: McpSecretInventory = { substitute: [], substituteBounded: [], withhold: [] };
  for (const location of listMcpSecretLocations(config)) {
    const value = location.value;
    if (value.length === 0) continue;
    if (value.length >= MCP_SECRET_MIN_SUBSTITUTION_LENGTH) {
      inventory.substitute.push(value);
    } else if (location.credential) {
      inventory.withhold.push(value);
    }
    for (const part of value.split(/\s+/u)) {
      if (part === value || part.length === 0) continue;
      if (part.length >= MCP_SECRET_MIN_SUBSTITUTION_LENGTH) {
        inventory.substitute.push(part);
      } else if (location.credential) {
        // The short tail of "Bearer x": an upstream reflecting the bare
        // fragment must still lose it, at token boundaries only.
        inventory.substituteBounded?.push(part);
      }
    }
  }
  return inventory;
}

/** Substitutes every known long secret and withholds the whole message when
 * an un-spliceable short credential appears in it. Longer secrets are
 * replaced first: with `abcd` and `abcdEFGH` both configured, processing
 * `abcd` first would shred `abcdEFGH` into `[redacted]EFGH` and leave its
 * tail exposed. */
export function scrubKnownMcpSecrets(message: string, secrets: McpSecretInventory): string {
  // Withholding is checked on the RAW message: substitution first could
  // consume a short credential embedded in a longer secret ("Bearer ab")
  // and let the message through as an in-place redaction, violating the
  // invariant that any message containing an un-spliceable credential is
  // withheld wholesale.
  if (secrets.withhold.some((secret) => message.includes(secret))) {
    return MCP_SECRET_WITHHELD_MESSAGE;
  }
  let result = message;
  for (const secret of [...new Set(secrets.substitute)].sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[redacted]');
  }
  for (const fragment of new Set(secrets.substituteBounded ?? [])) {
    result = result.replace(boundedFragmentPattern(fragment), '[redacted]');
  }
  return result;
}

/** Matches a short credential fragment only as a standalone token, so
 * scrubbing "x" redacts `token x expired` without shredding "example". */
function boundedFragmentPattern(fragment: string): RegExp {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'gu');
}

/** Scrubs every string in a payload — object keys included, since a server
 * can smuggle a credential through a property name. No pattern redaction:
 * payloads are user data, and mangling a value that merely looks like a
 * token is not this boundary's job. */
export function deepScrubMcpSecrets<T>(value: T, secrets: McpSecretInventory): T {
  if (
    secrets.substitute.length === 0 &&
    secrets.withhold.length === 0 &&
    (secrets.substituteBounded?.length ?? 0) === 0
  ) {
    return value;
  }
  if (typeof value === 'string') return scrubKnownMcpSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => deepScrubMcpSecrets(item, secrets)) as T;
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        scrubKnownMcpSecrets(key, secrets),
        deepScrubMcpSecrets(item, secrets),
      ]),
    ) as T;
  }
  return value;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
