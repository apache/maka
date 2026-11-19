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
import { watchUsageLimits, type UsageReading, type UsageResult } from './usageLimitsReading.ts';

type UsageLimitsOutput = ServiceMethods['settings']['connectionUsageLimits']['output'];
export type UsageLimitEntry = Extract<UsageLimitsOutput, { kind: 'ready' }>['limits'][number];
type UsageLimitPeriod = Extract<UsageLimitEntry, { kind: 'window' }>['period'];
export type UsageTone = 'normal' | 'warning' | 'danger';

export type ComposerUsageSummary =
  | {
      kind: 'window';
      limit: Extract<UsageLimitEntry, { kind: 'window' }>;
      shortWindow: string;
      remainingPercent: number;
      tone: UsageTone;
    }
  | {
      kind: 'balance';
      limit: Extract<UsageLimitEntry, { kind: 'balance' }>;
      text: string;
    };

export type ComposerUsageTarget =
  | { key: string; kind: 'connection'; connectionId: string }
  | { key: string; kind: 'external'; runtime: AgentNativeRuntime };

export type ComposerUsageObservation = {
  reading: UsageReading;
  sourceName: string;
};

export interface ComposerUsageHost {
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
    input: { runtime: AgentNativeRuntime },
  ): Promise<UsageResult>;
}

const EXTERNAL_USAGE_RUNTIMES = new Set<string>(['antigravity', 'codex', 'claude']);

export const EXTERNAL_USAGE_RUNTIME_NAMES: Record<AgentNativeRuntime, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex',
  claude: 'Claude Code',
};

export function isExternalUsageRuntime(
  runtime: string | null | undefined,
): runtime is AgentNativeRuntime {
  return typeof runtime === 'string' && EXTERNAL_USAGE_RUNTIMES.has(runtime);
}

export function usageSeverity(usedPercent: number): UsageTone {
  return usedPercent >= 95 ? 'danger' : usedPercent >= 80 ? 'warning' : 'normal';
}

export function shortUsagePeriod(period: UsageLimitPeriod | undefined): string {
  if (!period) return '';
  if (period.kind === 'monthly') return '1m';
  const seconds = period.seconds;
  if (seconds <= 0) return '';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function summarizeComposerUsage(
  limits: readonly UsageLimitEntry[],
  formatNumber: (value: number) => string = (value) => String(Math.round(value * 100) / 100),
): ComposerUsageSummary | null {
  const windows = limits.filter(
    (entry): entry is Extract<UsageLimitEntry, { kind: 'window' }> => entry.kind === 'window',
  );
  if (windows.length) {
    let hottest = windows[0]!;
    for (let i = 1; i < windows.length; i++) {
      if (windows[i]!.usedPercent > hottest.usedPercent) hottest = windows[i]!;
    }
    const remainingPercent = Math.max(0, Math.min(100, Math.round(100 - hottest.usedPercent)));
    return {
      kind: 'window',
      limit: hottest,
      shortWindow: shortUsagePeriod(hottest.period),
      remainingPercent,
      tone: usageSeverity(hottest.usedPercent),
    };
  }
  const balance = limits.find(
    (entry): entry is Extract<UsageLimitEntry, { kind: 'balance' }> => entry.kind === 'balance',
  );
  if (balance) {
    const formatted = formatNumber(balance.amount);
    const unit = balance.unit?.trim() ?? '';
    const text =
      unit === '$' || unit === '€' || unit === '£' || unit === '¥'
        ? `${unit}${formatted}`
        : [formatted, unit].filter(Boolean).join(' ');
    return { kind: 'balance', limit: balance, text };
  }
  return null;
}

type BasisResolution =
  | { kind: 'ready'; basis: ConnectionVersionBasis; name: string }
  | { kind: 'disabled' }
  | { kind: 'missing' }
  | { kind: 'stale' };

export function watchComposerUsage(
  host: ComposerUsageHost,
  target: ComposerUsageTarget,
  publish: (observation: ComposerUsageObservation) => void,
  previous: ComposerUsageObservation | null,
): () => void {
  let stopped = false;
  let cachedConnection: { basis: ConnectionVersionBasis; name: string } | null = null;
  let committedSource =
    target.kind === 'external'
      ? EXTERNAL_USAGE_RUNTIME_NAMES[target.runtime]
      : (previous?.sourceName ?? '');
  let pendingSource = committedSource;

  const resolveBasis = async (connectionId: string): Promise<BasisResolution> => {
    const detail = await host.query('settings', 'connection', {
      connectionId,
      includeEditingFacts: false,
    });
    if (stopped) return { kind: 'stale' };
    if (detail.kind !== 'ready') {
      return detail.actual === null ? { kind: 'missing' } : { kind: 'stale' };
    }
    if (!detail.enabled) {
      cachedConnection = null;
      return { kind: 'disabled' };
    }
    cachedConnection = {
      basis: {
        connectionId: detail.target.connectionId,
        revision: detail.target.revision,
      },
      name: detail.name,
    };
    return { kind: 'ready', ...cachedConnection };
  };

  const query = async (): Promise<UsageResult> => {
    if (stopped) return { kind: 'unavailable' };
    if (target.kind === 'external') {
      pendingSource = EXTERNAL_USAGE_RUNTIME_NAMES[target.runtime];
      return host.query('agent', 'externalUsageLimits', { runtime: target.runtime });
    }

    let connection = cachedConnection;
    if (!connection) {
      const resolved = await resolveBasis(target.connectionId);
      if (stopped) return { kind: 'unavailable' };
      if (resolved.kind === 'missing') return { kind: 'unsupported' };
      if (resolved.kind !== 'ready') return { kind: 'superseded' };
      connection = resolved;
    }

    const first = await host.query('settings', 'connectionUsageLimits', connection.basis);
    if (stopped) return { kind: 'unavailable' };
    if (first.kind !== 'superseded') {
      pendingSource = connection.name;
      return first;
    }

    cachedConnection = null;
    let resolved: BasisResolution;
    try {
      resolved = await resolveBasis(target.connectionId);
    } catch {
      return { kind: 'superseded' };
    }
    if (stopped) return { kind: 'unavailable' };
    if (resolved.kind === 'missing') return { kind: 'unsupported' };
    if (resolved.kind !== 'ready') return { kind: 'superseded' };

    let retried: UsageResult;
    try {
      retried = await host.query('settings', 'connectionUsageLimits', resolved.basis);
    } catch {
      return { kind: 'superseded' };
    }
    if (stopped) return { kind: 'unavailable' };
    if (retried.kind === 'unavailable') return { kind: 'superseded' };
    pendingSource = resolved.name;
    return retried;
  };

  const stopWatcher = watchUsageLimits(
    query,
    (reading) => {
      if (stopped) return;
      if (!reading.refreshFailed) committedSource = pendingSource;
      publish({ reading, sourceName: committedSource });
    },
    previous?.reading ?? null,
  );

  return () => {
    stopped = true;
    stopWatcher();
  };
}
