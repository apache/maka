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
  ServiceMethods,
} from '../../../../packages/plugin-sdk/src/index.js';

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

const EXTERNAL_USAGE_RUNTIMES = new Set<string>(['antigravity', 'codex', 'claude']);

export function isExternalUsageRuntime(
  runtime: string | null | undefined,
): runtime is AgentNativeRuntime {
  return typeof runtime === 'string' && EXTERNAL_USAGE_RUNTIMES.has(runtime);
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
    const tone: UsageTone =
      remainingPercent <= 5 ? 'danger' : remainingPercent <= 20 ? 'warning' : 'normal';
    return {
      kind: 'window',
      limit: hottest,
      shortWindow: shortUsagePeriod(hottest.period),
      remainingPercent,
      tone,
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
