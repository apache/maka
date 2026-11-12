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

import { cleanup, effect, lifecycle, platform, signal, Text, untracked, View } from 'nsh';
import { currentLocale, tr } from './locale';
import { watchUsageLimits, type UsageReading, type UsageResult } from './usageLimitsReading';
import { C, captionTextStyle } from './ui';

function usageWindow(seconds: number) {
  if (seconds === 604800) return tr('Weekly limit');
  const units = [
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as const;
  const [unit, size] = units.find(([, size]) => seconds % size === 0) ?? units[4];
  return tr('{duration} limit', {
    duration: new Intl.NumberFormat(currentLocale(), { style: 'unit', unit }).format(
      seconds / size,
    ),
  });
}

type Limit = Extract<UsageResult, { kind: 'ready' }>['limits'][number];

function usageNumber(value: number) {
  return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 2 }).format(value);
}

function usageLabel(limit: Limit) {
  if (limit.kind === 'balance') return limit.label ?? tr('Balance');
  if (limit.kind === 'unlimited') return limit.label ?? tr('Usage limit');
  const period =
    limit.period?.kind === 'monthly'
      ? tr('Monthly limit')
      : limit.period?.kind === 'duration'
        ? usageWindow(limit.period.seconds)
        : '';
  return [limit.label, period].filter(Boolean).join(' · ') || tr('Usage limit');
}

function usageValue(limit: Limit) {
  if (limit.kind === 'balance')
    return [usageNumber(limit.amount), limit.unit].filter(Boolean).join(' ');
  if (limit.kind === 'unlimited') return tr('Unlimited');
  if (limit.kind === 'disabled') return tr('Disabled');
  const percent = tr('{percent}% used', { percent: usageNumber(limit.usedPercent) });
  if (!limit.quantity) return percent;
  const { used, limit: total, unit } = limit.quantity;
  return `${percent} · ${usageNumber(used)} / ${usageNumber(total)}${unit ? ` ${unit}` : ''}`;
}

export function UsageLimits(props: { query: () => Promise<UsageResult>; revision?: number }) {
  const usage = signal<UsageReading | null>(null);
  let lastRevision: number | undefined;
  let stop: (() => void) | undefined;
  cleanup(() => stop?.());
  effect(() => {
    const current = props.revision;
    stop?.();
    stop = undefined;
    if (current !== lastRevision) usage.set(null);
    lastRevision = current;
    if (lifecycle() !== 'active') return;
    stop = watchUsageLimits(
      () => untracked(props.query),
      (reading) => usage.set(reading),
      untracked(usage),
    );
  });
  const limits = () => {
    const result = usage()?.result;
    return result?.kind === 'ready' ? result.limits : [];
  };
  const message = () => {
    if (usage()?.refreshFailed) return tr('Last usage refresh failed');
    switch (usage()?.result.kind) {
      case 'ready':
        return limits().length ? '' : tr('No usage limits reported');
      case 'unsupported':
        return '';
      case 'authentication_required':
        return tr('Update the connection credential to see usage limits');
      case 'usage_credential_required':
        return tr('Add or update the usage access key');
      case 'unavailable':
      case 'superseded':
        return tr('Usage limits unavailable');
      default:
        return tr('Loading usage limits…');
    }
  };
  const terminal = platform.idiom === 'terminal';
  return (
    <View style={{ gap: terminal ? 0 : 6, marginTop: terminal ? 0 : 4 }}>
      <If when={message()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{message()}</Text>
      </If>
      <Each of={limits()}>
        {(entry) => {
          const reset = () => {
            const limit = entry();
            const timestamp = limit.kind === 'window' ? limit.resetsAt : null;
            return timestamp == null
              ? ''
              : tr('Resets {time}', {
                  time: new Date(timestamp * 1000).toLocaleString(currentLocale(), {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  }),
                });
          };
          const used = () => {
            const limit = entry();
            return limit.kind === 'window' ? limit.usedPercent : null;
          };
          return (
            <View style={{ gap: terminal ? 0 : 3 }}>
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {usageLabel(entry())} · {usageValue(entry())}
              </Text>
              <If when={!terminal && used() !== null}>
                <View style={{ height: 3, borderRadius: 2, backgroundColor: C.line }}>
                  <View
                    style={{
                      width: `${Math.min(100, used() ?? 0)}%`,
                      height: 3,
                      borderRadius: 2,
                      backgroundColor: (used() ?? 0) >= 100 ? C.warning : C.accent,
                    }}
                  />
                </View>
              </If>
              <If when={reset()}>
                <Text style={{ ...captionTextStyle, color: C.muted }}>{reset()}</Text>
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
