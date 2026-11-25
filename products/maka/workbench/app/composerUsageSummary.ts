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

import type { UsageResult } from './usageLimitsReading.ts';

export type UsageLimitEntry = Extract<UsageResult, { kind: 'ready' }>['limits'][number];
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
      compactText: string;
    };

export function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
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
  model: string | null = null,
): ComposerUsageSummary | null {
  const all = limits.filter(
    (entry): entry is Extract<UsageLimitEntry, { kind: 'window' }> => entry.kind === 'window',
  );
  const applicable = all.filter(
    (entry) =>
      !entry.models?.length ||
      (model !== null &&
        entry.models.some((name) => model === name || model.startsWith(`${name} (`))),
  );
  const windows = applicable.length ? applicable : all;
  if (windows.length) {
    let hottest = windows[0]!;
    for (let i = 1; i < windows.length; i++) {
      if (windows[i]!.usedPercent > hottest.usedPercent) hottest = windows[i]!;
    }
    return {
      kind: 'window',
      limit: hottest,
      shortWindow: shortUsagePeriod(hottest.period),
      remainingPercent: remainingPercent(hottest.usedPercent),
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
    const compactText = formatCompactBalance(balance.amount, unit, formatNumber);
    return { kind: 'balance', limit: balance, text, compactText };
  }
  return null;
}

const COMPACT_CURRENCY_SYMBOLS: Record<string, string> = {
  $: '$',
  '€': '€',
  '£': '£',
  '¥': '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  CNY: '¥',
  RMB: '¥',
  JPY: '¥',
};

function formatCompactBalance(
  amount: number,
  unit: string | undefined,
  formatNumber: (value: number) => string = (value) => String(Math.round(value * 100) / 100),
): string {
  const trimmed = unit?.trim() ?? '';
  const value = Math.abs(amount) >= 10 ? Math.sign(amount) * Math.round(Math.abs(amount)) : amount;
  const formatted = formatNumber(value);
  const symbol =
    COMPACT_CURRENCY_SYMBOLS[trimmed.toUpperCase()] ?? COMPACT_CURRENCY_SYMBOLS[trimmed];
  if (symbol) {
    const absFormatted = formatNumber(Math.abs(value));
    if (formatted.endsWith(absFormatted) && formatted.length > absFormatted.length) {
      return `${formatted.slice(0, formatted.length - absFormatted.length)}${symbol}${absFormatted}`;
    }
    return `${symbol}${formatted}`;
  }
  return [formatted, trimmed].filter(Boolean).join(' ');
}
