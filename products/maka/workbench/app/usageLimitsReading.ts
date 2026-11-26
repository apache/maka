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

import type {
  AgentNativeRuntime,
  ConnectionVersionBasis,
  ServiceMethods,
  SettingsConnectionDetail,
} from '../../../../packages/plugin-sdk/src/index.js';

export type UsageResult = ServiceMethods['settings']['connectionUsageLimits']['output'];
type UsageReading = { result: UsageResult; refreshFailed: boolean };

export type UsageTarget =
  | {
      kind: 'connection';
      connectionId: string;
      basis?: ConnectionVersionBasis;
      sourceName?: string;
    }
  | { kind: 'external'; runtime: AgentNativeRuntime };

export type UsageObservation = { reading: UsageReading; sourceName: string };

export interface UsageLimitsHost {
  query(
    endpoint: 'settings',
    method: 'connection',
    input: { connectionId: string; includeEditingFacts?: boolean },
  ): Promise<SettingsConnectionDetail>;
  query(
    endpoint: 'settings',
    method: 'connectionUsageLimits',
    input: ConnectionVersionBasis,
  ): Promise<UsageResult>;
  query(
    endpoint: 'agent',
    method: 'externalUsageLimits',
    input: { runtime: AgentNativeRuntime; refresh?: boolean },
  ): Promise<UsageResult>;
}

const EXTERNAL_USAGE_RUNTIME_NAMES: Record<AgentNativeRuntime, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex',
  claude: 'Claude Code',
};

export function isExternalUsageRuntime(
  runtime: string | null | undefined,
): runtime is AgentNativeRuntime {
  return typeof runtime === 'string' && Object.hasOwn(EXTERNAL_USAGE_RUNTIME_NAMES, runtime);
}

export function usageTargetKey(target: UsageTarget): string {
  return target.kind === 'external'
    ? `external:${target.runtime}`
    : `connection:${target.connectionId}`;
}

const STORE_KEY = Symbol.for('maka.usageLimitsStore');
const HOST_IDENTITY = Symbol.for('maka.hostIdentity');
const REFRESH_INTERVAL = 60_000;

type SharedEntry = {
  host: UsageLimitsHost;
  target:
    | { kind: 'connection'; connectionId: string }
    | { kind: 'external'; runtime: AgentNativeRuntime };
  subscribers: Set<(observation: UsageObservation | null) => void>;
  observation: UsageObservation | null;
  cachedConnection: { basis: ConnectionVersionBasis; name: string } | null;
  lastKnownRevision: number | null;
  freshUntil: number;
  inFlight: boolean;
  forceRefresh: boolean;
  generation: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

function clearTimer(entry: SharedEntry) {
  if (entry.timer === undefined) return;
  clearTimeout(entry.timer);
  entry.timer = undefined;
}

function scheduleRefresh(entry: SharedEntry, delayMs: number) {
  clearTimer(entry);
  if (entry.subscribers.size === 0) return;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (entry.subscribers.size > 0 && !entry.inFlight) void fetchEntry(entry);
  }, delayMs);
}

async function resolveBasis(entry: SharedEntry, connectionId: string, generation: number) {
  const detail = await entry.host.query('settings', 'connection', {
    connectionId,
    includeEditingFacts: false,
  });
  if (entry.generation !== generation) return { kind: 'stale' as const };
  if (detail.kind !== 'ready') {
    return detail.actual === null ? { kind: 'missing' as const } : { kind: 'stale' as const };
  }
  if (!detail.enabled) {
    entry.cachedConnection = null;
    return { kind: 'disabled' as const };
  }
  entry.cachedConnection = {
    basis: { connectionId: detail.target.connectionId, revision: detail.target.revision },
    name: detail.name,
  };
  entry.lastKnownRevision = detail.target.revision;
  return { kind: 'ready' as const, ...entry.cachedConnection };
}

async function queryEntry(
  entry: SharedEntry,
  generation: number,
): Promise<{ result: UsageResult; sourceName?: string }> {
  if (entry.target.kind === 'external') {
    const refresh = entry.forceRefresh;
    entry.forceRefresh = false;
    return {
      result: await entry.host.query(
        'agent',
        'externalUsageLimits',
        refresh
          ? { runtime: entry.target.runtime, refresh: true }
          : { runtime: entry.target.runtime },
      ),
      sourceName: EXTERNAL_USAGE_RUNTIME_NAMES[entry.target.runtime],
    };
  }

  let connection = entry.cachedConnection;
  if (!connection) {
    const resolved = await resolveBasis(entry, entry.target.connectionId, generation);
    if (entry.generation !== generation) return { result: { kind: 'unavailable' } };
    if (resolved.kind === 'missing') return { result: { kind: 'unsupported' } };
    if (resolved.kind !== 'ready') return { result: { kind: 'superseded' } };
    connection = resolved;
  }

  const first = await entry.host.query('settings', 'connectionUsageLimits', connection.basis);
  if (entry.generation !== generation) return { result: { kind: 'unavailable' } };
  if (first.kind !== 'superseded') return { result: first, sourceName: connection.name };

  entry.cachedConnection = null;
  let resolved: Awaited<ReturnType<typeof resolveBasis>>;
  try {
    resolved = await resolveBasis(entry, entry.target.connectionId, generation);
  } catch {
    return { result: { kind: 'superseded' } };
  }
  if (entry.generation !== generation) return { result: { kind: 'unavailable' } };
  if (resolved.kind === 'missing') return { result: { kind: 'unsupported' } };
  if (resolved.kind !== 'ready') return { result: { kind: 'superseded' } };

  let retried: UsageResult;
  try {
    retried = await entry.host.query('settings', 'connectionUsageLimits', resolved.basis);
  } catch {
    return { result: { kind: 'superseded' } };
  }
  if (entry.generation !== generation) return { result: { kind: 'unavailable' } };
  if (retried.kind === 'unavailable') return { result: { kind: 'superseded' } };
  return { result: retried, sourceName: resolved.name };
}

async function fetchEntry(entry: SharedEntry) {
  const generation = entry.generation;
  entry.inFlight = true;
  clearTimer(entry);

  let result: UsageResult;
  let sourceName: string | undefined;
  try {
    ({ result, sourceName } = await queryEntry(entry, generation));
  } catch {
    result = { kind: 'unavailable' };
  }
  if (entry.generation !== generation) return;
  entry.inFlight = false;

  const previous = entry.observation;
  const observation: UsageObservation =
    result.kind === 'unavailable' && previous?.reading.result.kind === 'ready'
      ? {
          reading: { result: previous.reading.result, refreshFailed: true },
          sourceName: previous.sourceName,
        }
      : {
          reading: { result, refreshFailed: false },
          sourceName:
            sourceName ??
            (entry.target.kind === 'external'
              ? EXTERNAL_USAGE_RUNTIME_NAMES[entry.target.runtime]
              : (previous?.sourceName ?? '')),
        };
  entry.observation = observation;
  entry.freshUntil = Date.now() + REFRESH_INTERVAL;
  for (const subscriber of [...entry.subscribers]) subscriber(observation);

  if (entry.subscribers.size > 0 && result.kind !== 'unsupported') {
    scheduleRefresh(entry, REFRESH_INTERVAL);
  }
}

function hostEntries(host: object, create: boolean): Map<string, SharedEntry> | undefined {
  const scope = globalThis as Record<PropertyKey, unknown>;
  let store = scope[STORE_KEY] as WeakMap<object, Map<string, SharedEntry>> | undefined;
  if (!store) {
    if (!create) return undefined;
    store = new WeakMap();
    scope[STORE_KEY] = store;
  }
  const identity = (host as Record<PropertyKey, unknown>)[HOST_IDENTITY];
  const hostKey = identity !== null && typeof identity === 'object' ? identity : host;
  let entries = store.get(hostKey);
  if (!entries && create) {
    entries = new Map();
    store.set(hostKey, entries);
  }
  return entries;
}

export function peekUsageLimits(host: object, target: UsageTarget): UsageObservation | null {
  const entries = hostEntries(host, false);
  return entries?.get(usageTargetKey(target))?.observation ?? null;
}

export function invalidateUsageLimits(host: object, target: UsageTarget) {
  const entries = hostEntries(host, false);
  const key = usageTargetKey(target);
  const entry = entries?.get(key);
  if (!entry) return;
  entry.generation++;
  entry.inFlight = false;
  entry.forceRefresh = true;
  clearTimer(entry);
  entry.observation = null;
  entry.freshUntil = 0;
  if (entry.subscribers.size === 0) {
    entries!.delete(key);
    return;
  }
  for (const subscriber of [...entry.subscribers]) subscriber(null);
  void fetchEntry(entry);
}

export function watchUsageLimits(
  host: UsageLimitsHost,
  target: UsageTarget,
  publish: (observation: UsageObservation | null) => void,
): () => void {
  const entries = hostEntries(host, true)!;
  const now = Date.now();
  const key = usageTargetKey(target);
  for (const [existingKey, existing] of entries) {
    if (
      existingKey !== key &&
      existing.subscribers.size === 0 &&
      !existing.inFlight &&
      existing.freshUntil <= now
    ) {
      entries.delete(existingKey);
    }
  }
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      host,
      target:
        target.kind === 'external'
          ? { kind: 'external', runtime: target.runtime }
          : { kind: 'connection', connectionId: target.connectionId },
      subscribers: new Set(),
      observation: null,
      cachedConnection: null,
      lastKnownRevision: null,
      freshUntil: 0,
      inFlight: false,
      forceRefresh: false,
      generation: 0,
      timer: undefined,
    };
    entries.set(key, entry);
  } else {
    entry.host = host;
  }

  if (target.kind === 'connection' && target.basis) {
    const incomingRevision = target.basis.revision;
    const supersedes =
      entry.lastKnownRevision === null
        ? entry.observation !== null || entry.inFlight
        : incomingRevision > entry.lastKnownRevision;
    if (supersedes) {
      entry.generation++;
      entry.inFlight = false;
      clearTimer(entry);
      entry.observation = null;
      entry.freshUntil = 0;
      entry.cachedConnection = { basis: target.basis, name: target.sourceName ?? '' };
      entry.lastKnownRevision = incomingRevision;
      for (const subscriber of [...entry.subscribers]) subscriber(null);
    } else if (entry.cachedConnection === null && entry.lastKnownRevision === null) {
      entry.cachedConnection = { basis: target.basis, name: target.sourceName ?? '' };
      entry.lastKnownRevision = incomingRevision;
    }
  }

  let active = true;
  const listener = (observation: UsageObservation | null) => {
    if (active) publish(observation);
  };
  entry.subscribers.add(listener);
  if (entry.observation !== null) listener(entry.observation);

  if (!entry.inFlight) {
    const remaining = entry.freshUntil - Date.now();
    if (entry.observation !== null && remaining > 0) {
      if (entry.observation.reading.result.kind !== 'unsupported' && entry.timer === undefined) {
        scheduleRefresh(entry, remaining);
      }
    } else {
      void fetchEntry(entry);
    }
  }

  const currentEntry = entry;
  return () => {
    if (!active) return;
    active = false;
    currentEntry.subscribers.delete(listener);
    if (currentEntry.subscribers.size === 0) clearTimer(currentEntry);
  };
}
