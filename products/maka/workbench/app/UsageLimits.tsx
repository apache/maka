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

import { formatDuration } from './duration';
import { cleanup, effect, lifecycle, platform, signal, Text, View } from 'nsh';
import { usageSeverity } from './composerUsageSummary';
import { useHost } from './host';
import { currentLocale, tr } from './locale';
import { formatDecimal } from './numberFormat';
import {
  usageTargetKey,
  watchUsageLimits,
  type UsageLimitsHost,
  type UsageObservation,
  type UsageResult,
  type UsageTarget,
} from './usageLimitsReading';
import { C, captionTextStyle } from './ui';
import { TokenCount } from './TokenCount';

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
  if (unit === 'second' && seconds >= 60)
    return tr('{duration} limit', { duration: formatDuration(seconds * 1000) });
  return tr('{duration} limit', {
    duration: new Intl.NumberFormat(currentLocale(), { style: 'unit', unit }).format(
      seconds / size,
    ),
  });
}

export type UsageLimit = Extract<UsageResult, { kind: 'ready' }>['limits'][number];

export function usageLabel(limit: UsageLimit) {
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

function remainingShare(usedPercent: number) {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function usageValue(limit: UsageLimit) {
  if (limit.kind === 'balance')
    return [formatDecimal(limit.amount, 2), limit.unit].filter(Boolean).join(' ');
  if (limit.kind === 'unlimited') return tr('Unlimited');
  if (limit.kind === 'disabled') return tr('Disabled');
  const percent = tr('{percent}% remaining', {
    percent: formatDecimal(remainingShare(limit.usedPercent), 2),
  });
  if (!limit.quantity) return percent;
  const { used, limit: total, unit } = limit.quantity;
  const left = Math.max(0, total - used);
  return `${percent} · ${formatDecimal(left, 2)} / ${formatDecimal(total, 2)}${unit ? ` ${unit}` : ''}`;
}

export function useUsageLimits(target: () => UsageTarget | null) {
  const host = useHost();
  const observation = signal<UsageObservation | null>(null);
  let activeKey: string | null = null;
  let activeRevision: number | undefined;
  let stop: (() => void) | undefined;
  const detach = () => {
    stop?.();
    stop = undefined;
  };
  cleanup(detach);
  effect(() => {
    const current = target();
    if (!current) {
      detach();
      activeKey = null;
      activeRevision = undefined;
      observation.set(null);
      return;
    }
    const key = usageTargetKey(current);
    const revision = current.kind === 'connection' ? current.basis?.revision : undefined;
    if (lifecycle() !== 'active') {
      detach();
      if (key !== activeKey || revision !== activeRevision) {
        activeKey = key;
        activeRevision = revision;
        observation.set(null);
      }
      return;
    }
    if (key === activeKey && revision === activeRevision && stop !== undefined) return;
    detach();
    activeKey = key;
    activeRevision = revision;
    observation.set(null);
    stop = watchUsageLimits(host as unknown as UsageLimitsHost, current, (next) => {
      observation.set(next);
    });
  });
  return observation;
}

export function UsageLimits(props: { target: () => UsageTarget }) {
  const observation = useUsageLimits(props.target);
  const usage = () => observation()?.reading ?? null;
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
      <UsageLimitsList limits={limits} />
    </View>
  );
}

export function UsageLimitsList(props: { limits: () => UsageLimit[] }) {
  const terminal = platform.idiom === 'terminal';
  return (
    <View style={{ gap: terminal ? 0 : 8 }}>
      <Each of={props.limits()}>
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
          const remaining = () => {
            const value = used();
            return value === null ? null : remainingShare(value);
          };
          const tokenQuantity = () => {
            const limit = entry();
            return limit.kind === 'window' && limit.quantity?.unit === 'tokens'
              ? limit.quantity
              : undefined;
          };
          const summary = () => {
            const limit = entry();
            return tokenQuantity() && limit.kind === 'window'
              ? tr('{percent}% remaining', { percent: formatDecimal(remaining() ?? 0, 2) })
              : usageValue(limit);
          };
          const barColor = () => {
            const tone = usageSeverity(used() ?? 0);
            return tone === 'danger' ? C.danger : tone === 'warning' ? C.warning : C.accent;
          };
          return (
            <View style={{ gap: terminal ? 0 : 3 }}>
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {usageLabel(entry())} · {summary()}
              </Text>
              <If when={tokenQuantity()}>
                <View
                  style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}
                >
                  <TokenCount
                    label={tr('Remaining tokens')}
                    value={Math.max(0, tokenQuantity()!.limit - tokenQuantity()!.used)}
                    style={captionTextStyle}
                  />
                  <Text style={{ ...captionTextStyle, color: C.muted }}>/</Text>
                  <TokenCount
                    label={tr('Token limit')}
                    value={tokenQuantity()!.limit}
                    format={(count) => tr('{count} tokens', { count })}
                    style={captionTextStyle}
                  />
                </View>
              </If>
              <If when={!terminal && remaining() !== null}>
                <View
                  style={{
                    height: 3,
                    borderRadius: 2,
                    backgroundColor: C.pressed,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      width: `${remaining() ?? 0}%`,
                      height: 3,
                      borderRadius: 2,
                      backgroundColor: barColor(),
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
