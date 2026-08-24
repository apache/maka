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

import type { LlmConnection } from '@maka/core/llm-connections';
import { isRetiredProvider } from '@maka/core/provider-registry';

/**
 * Config import / export — Alma-style selective bundle.
 *
 * A single JSON bundle carries a manifest (`includedData`) plus a `data` map
 * keyed by category. The user chooses which categories to export; the manifest
 * records exactly what is present, and import applies only those categories.
 *
 * This module is category-agnostic on purpose: each category payload is opaque
 * (`unknown`) here. The desktop layer owns what goes into each one — including
 * the sensitive parts (deciding whether to gather credentials, and stripping
 * secret fields out of `settings` when credentials are NOT included). Keeping
 * that knowledge out of this module means the pure transfer logic never has to
 * understand the AppSettings/credential shapes.
 *
 * `credentials` is an opt-in category that carries plaintext secrets. It is
 * never implied: if it is not listed in `includedData`, any `data.credentials`
 * payload is dropped on read so a hand-edited or mislabeled file cannot sneak
 * secrets past a config-only import. The UI must warn before selecting it.
 *
 * Reads fail closed on unknown schema versions (mirrors credential-store).
 */

export const CONFIG_TRANSFER_SCHEMA_VERSION = 1;

export const CONFIG_CATEGORIES = ['connections', 'settings', 'credentials', 'memory'] as const;
export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number];

/** Categories that carry plaintext secrets and must be explicitly opted into. */
export const SENSITIVE_CATEGORIES: ReadonlySet<ConfigCategory> = new Set(['credentials']);

export type ConfigData = Partial<Record<ConfigCategory, unknown>>;

export interface ConfigBundle {
  schemaVersion: number;
  exportedAt: string;
  appVersion: string;
  includedData: ConfigCategory[];
  data: ConfigData;
}

export interface BuildConfigBundleInput {
  appVersion: string;
  /** Only the categories the user selected; presence here == inclusion. */
  data: ConfigData;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export function buildConfigBundle(input: BuildConfigBundleInput): ConfigBundle {
  const now = input.now ?? (() => new Date());
  const includedData = CONFIG_CATEGORIES.filter((c) => input.data[c] !== undefined);
  const data: ConfigData = {};
  for (const category of includedData) {
    data[category] = cloneJson(input.data[category]);
  }
  return {
    schemaVersion: CONFIG_TRANSFER_SCHEMA_VERSION,
    exportedAt: now().toISOString(),
    appVersion: input.appVersion,
    includedData,
    data,
  };
}

export function serializeConfigBundle(bundle: ConfigBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export type ConfigParseFailure = {
  ok: false;
  reason: 'not_json' | 'malformed' | 'unsupported_version';
  message: string;
};

export type ConfigParseResult = { ok: true; bundle: ConfigBundle } | ConfigParseFailure;

export function parseConfigBundle(raw: string): ConfigParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not_json', message: 'File is not valid JSON.' };
  }
  if (!isJsonObject(parsed)) {
    return { ok: false, reason: 'malformed', message: 'Config bundle must be a JSON object.' };
  }
  const version = parsed.schemaVersion;
  if (typeof version !== 'number') {
    return {
      ok: false,
      reason: 'malformed',
      message: 'Config bundle is missing a numeric schemaVersion.',
    };
  }
  if (version !== CONFIG_TRANSFER_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'unsupported_version',
      message: `Unsupported config schemaVersion ${version} (this build reads ${CONFIG_TRANSFER_SCHEMA_VERSION}).`,
    };
  }
  if (!Array.isArray(parsed.includedData) || !parsed.includedData.every(isConfigCategory)) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'includedData must be an array of known categories.',
    };
  }
  const rawData = isJsonObject(parsed.data) ? parsed.data : {};
  const includedData = [...new Set(parsed.includedData as ConfigCategory[])];
  const data: ConfigData = {};
  // Only surface categories that are BOTH declared in the manifest AND present
  // in `data`. A category listed but absent, or present but not listed, is
  // ignored — never guessed. This is what drops an unlisted `credentials`.
  for (const category of includedData) {
    if (rawData[category] !== undefined) data[category] = rawData[category];
  }
  const bundle: ConfigBundle = {
    schemaVersion: CONFIG_TRANSFER_SCHEMA_VERSION,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '',
    includedData: includedData.filter((c) => data[c] !== undefined),
    data,
  };
  return { ok: true, bundle };
}

// --- connection merge planning (import applies this against the live store) ---

export type ConnectionConflictStrategy = 'skip' | 'overwrite';

export interface ConnectionMergePlan {
  create: LlmConnection[];
  overwrite: LlmConnection[];
  skipped: Array<{ slug: string; reason: 'exists' | 'provider_retired' }>;
}

export function planConnectionMerge(
  existing: readonly LlmConnection[],
  incoming: readonly LlmConnection[],
  strategy: ConnectionConflictStrategy,
): ConnectionMergePlan {
  const existingSlugs = new Set(existing.map((c) => c.slug));
  const plan: ConnectionMergePlan = { create: [], overwrite: [], skipped: [] };
  const seen = new Set<string>();
  for (const conn of incoming) {
    if (seen.has(conn.slug)) continue; // de-dupe within the imported set
    seen.add(conn.slug);
    // A backup taken before a provider was retired still carries its
    // connection, and the catalog refuses to create one — rightly, since it
    // could never execute. Planning it as skipped is what keeps that refusal
    // from aborting the restore partway and leaving the rest of the bundle
    // (settings, credentials, memory) unapplied. Its credential is skipped
    // with it: only a created or overwritten slug gets its secret written.
    if (isRetiredProvider(conn.providerType)) {
      plan.skipped.push({ slug: conn.slug, reason: 'provider_retired' });
      continue;
    }
    if (existingSlugs.has(conn.slug)) {
      if (strategy === 'overwrite') plan.overwrite.push(cloneJson(conn));
      else plan.skipped.push({ slug: conn.slug, reason: 'exists' });
    } else {
      plan.create.push(cloneJson(conn));
    }
  }
  return plan;
}

export function isConfigCategory(value: unknown): value is ConfigCategory {
  return typeof value === 'string' && (CONFIG_CATEGORIES as readonly string[]).includes(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
