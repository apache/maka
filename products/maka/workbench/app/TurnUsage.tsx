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

import { formatCount } from './numberFormat';
import { UiError, errorText, renderText, type UiText } from './text';
import { currentLocale, tr } from './locale';
import { formatDuration } from './duration';
import { TokenCount } from './TokenCount';
import { cleanup, computed, inputAction, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type {
  ExecutorTurnUsage,
  PromptCacheUsage,
  ServiceMethods,
  SettingsUsageRead,
  UsageActivityCursor,
  UsageFence,
  UsageModelAttempt,
} from '../../../../packages/plugin-sdk/src/index.js';
import { useHost } from './host';
import { C, controlStyle, controlHoverStyle, controlFocusStyle } from './ui';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsButton } from './SettingsPage';

type Reading =
  | { kind: 'loading'; checked: number }
  | { kind: 'ready'; attempts: UsageModelAttempt[] }
  | { kind: 'failed'; message: UiText };
type Counter =
  | 'input_tokens'
  | 'output_tokens'
  | 'reasoning_tokens'
  | 'cache_read_tokens'
  | 'cache_write_tokens';

function total(attempts: UsageModelAttempt[], key: Counter | 'costUsd') {
  let value = 0;
  let reported = 0;
  for (const attempt of attempts) {
    const next = key === 'costUsd' ? attempt.costUsd : attempt.usage[key];
    if (next == null) continue;
    if (key !== 'costUsd' && (!Number.isSafeInteger(next) || next < 0)) return null;
    value += next;
    reported++;
  }
  const validSum = key === 'costUsd' ? Number.isFinite(value) : Number.isSafeInteger(value);
  return reported > 0 && validSum ? { value, reported } : null;
}

function withCoverage(value: string, reported: number, requests: number): string {
  return reported === requests
    ? value
    : tr('{value} ({reported}/{requests} requests)', {
        value,
        reported: formatCount(reported),
        requests: formatCount(requests),
      });
}

export function cacheHitRate(cache: PromptCacheUsage): string {
  const format = new Intl.NumberFormat(currentLocale(), {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const rate = cache.readTokens / cache.inputTokens;
  if (rate > 0 && rate < 0.001) return `<${format.format(0.001)}`;
  if (rate > 0.999 && rate < 1) return `>${format.format(0.999)}`;
  return format.format(rate);
}

export function ExecutorTokenCounts(props: {
  usage: ExecutorTurnUsage;
  style: NonNullable<Parameters<typeof TokenCount>[0]['style']>;
}) {
  const counts = () => {
    const { totalTokens, tokens } = props.usage;
    const counters =
      totalTokens != null
        ? ([[totalTokens, '{count} tokens']] as const)
        : ([
            [tokens.input_tokens, '{count} input tokens'],
            [tokens.output_tokens, '{count} output tokens'],
          ] as const);
    return counters.flatMap(([value, label]) => (value == null ? [] : [{ label, value }]));
  };
  return (
    <Each of={counts()} key={(counter) => counter.label}>
      {(counter) => (
        <TokenCount
          value={counter().value}
          format={(count) => tr(counter().label, { count })}
          style={props.style}
        />
      )}
    </Each>
  );
}

/** Read original turn accounting at one captured usage fence, including across retries. */
export function TurnUsage(props: {
  sessionId: string;
  turnId: string;
  current(): boolean;
  reported?: ExecutorTurnUsage;
  promptCache?: PromptCacheUsage | null;
  close(): void;
}) {
  const host = useHost();
  const reading = signal<Reading>({ kind: 'loading', checked: 0 });
  let alive = true;
  let through: UsageFence | null = null;
  cleanup(() => {
    alive = false;
  });
  const active = () => alive && props.current();
  const read = async () => {
    if (!active()) return;
    reading.set({ kind: 'loading', checked: 0 });
    try {
      const matching: UsageModelAttempt[] = [];
      const seen = new Set<string>();
      let cursor: UsageActivityCursor | null = null;
      let checked = 0;
      let expectedTotal: number | null = null;
      for (;;) {
        const fence = through;
        const request: SettingsUsageRead = {
          range: {
            from: 0,
            to: Number.MAX_SAFE_INTEGER,
            sessionId: props.sessionId,
            through: fence,
          },
          selection: { kind: 'model', status: null, search: '' },
          cursor,
        };
        const page: ServiceMethods['settings']['usage']['output'] = await host.query(
          'settings',
          'usage',
          request,
        );
        if (!active()) return;
        const nextCursor = page.nextCursor ?? null;
        checked += page.attempts.length;
        if (
          (fence !== null &&
            (page.through.stateDomain !== fence.stateDomain ||
              page.through.sequence !== fence.sequence)) ||
          !Number.isSafeInteger(page.total) ||
          page.total < 0 ||
          (expectedTotal !== null && page.total !== expectedTotal) ||
          checked > page.total ||
          (nextCursor === null
            ? checked !== page.total
            : checked >= page.total || page.attempts.length === 0)
        )
          throw new UiError('The original turn usage page could not be verified.');
        through = page.through;
        expectedTotal = page.total;
        for (const activity of page.attempts) {
          if (
            activity.kind !== 'model' ||
            activity.attempt.sessionId !== props.sessionId ||
            seen.has(activity.attempt.requestId)
          )
            throw new UiError('The Host returned inconsistent model usage.');
          const attempt = activity.attempt;
          seen.add(attempt.requestId);
          const origin = attempt.origin;
          if (
            origin.kind === 'agent' &&
            origin.purpose === 'main' &&
            origin.execution.sessionId === props.sessionId &&
            origin.execution.turnId === props.turnId
          )
            matching.push(attempt);
        }
        if (nextCursor === null) break;
        cursor = nextCursor;
        reading.set({ kind: 'loading', checked });
      }
      reading.set({ kind: 'ready', attempts: matching });
    } catch (reason) {
      if (active())
        reading.set({
          kind: 'failed',
          message: errorText(reason, 'Could not read request usage.'),
        });
    }
  };
  if (!props.reported) void Promise.resolve().then(read);
  const attempts = () => {
    const result = reading();
    return result.kind === 'ready' ? result.attempts : [];
  };
  const counters = (): { key: Counter; label: string }[] => [
    { key: 'input_tokens', label: tr('Input tokens') },
    { key: 'output_tokens', label: tr('Output tokens') },
    { key: 'reasoning_tokens', label: tr('Reasoning tokens') },
    { key: 'cache_read_tokens', label: tr('Cache read tokens') },
    { key: 'cache_write_tokens', label: tr('Cache write tokens') },
  ];
  const reportedCounters = () => {
    const usage = props.reported;
    if (!usage) return [];
    const counts: { label: string; value: number | string }[] = counters().flatMap(
      ({ key, label }) => {
        const value = usage.tokens[key];
        return value == null ? [] : [{ label, value }];
      },
    );
    if (usage.totalTokens != null)
      counts.push({ label: tr('Total tokens'), value: usage.totalTokens });
    if (usage.durationMs != null)
      counts.push({ label: tr('Duration'), value: formatDuration(usage.durationMs, 'tenths') });
    return counts;
  };
  const cost = () => {
    const requests = attempts();
    const sum = total(requests, 'costUsd');
    return sum
      ? withCoverage(`$${sum.value.toFixed(6)}`, sum.reported, requests.length)
      : tr('Unavailable');
  };
  return (
    <ModalDialog size="form" onCancel={props.close}>
      <DialogHeader title={props.reported ? tr('Turn usage') : tr('Main model usage')} />
      <Scroll style={{ flexShrink: 1, minHeight: 0 }}>
        <View style={{ gap: 8 }}>
          <If when={props.promptCache}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
              <Text style={{ flex: 1, color: C.secondary }}>{tr('Cache hit rate')}</Text>
              <Text style={[{ color: C.text }, { userSelect: 'text' }]}>
                {cacheHitRate(props.promptCache!)}
              </Text>
            </View>
          </If>
          <If when={!!props.reported}>
            <Each of={reportedCounters()} key={(counter) => counter.label}>
              {(counter) => (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
                  <Text style={{ flex: 1, color: C.secondary }}>{counter().label}</Text>
                  <If
                    when={typeof counter().value === 'number'}
                    else={
                      <Text style={{ color: C.text, userSelect: 'text' }}>{counter().value}</Text>
                    }
                  >
                    <TokenCount label={counter().label} value={counter().value as number} />
                  </If>
                </View>
              )}
            </Each>
          </If>
          <If when={!props.reported && reading().kind === 'loading'}>
            <Text style={{ color: C.muted }}>
              {tr('Reading original usage… {count} records checked', {
                count: formatCount((reading() as Extract<Reading, { kind: 'loading' }>).checked),
              })}
            </Text>
          </If>
          <If when={reading().kind === 'failed'}>
            <Text style={[{ color: C.danger }, { userSelect: 'text' }]}>
              {reading().kind === 'failed'
                ? renderText((reading() as Extract<Reading, { kind: 'failed' }>).message)
                : ''}
            </Text>
            <Button
              accessibilityLabel={tr('Retry original turn usage')}
              style={controlStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              onPress={inputAction(read, {
                sessionId: props.sessionId,
                turnId: props.turnId,
                through,
              })}
            >
              <Text style={{ color: C.accent }}>{tr('Retry')}</Text>
            </Button>
          </If>
          <If when={reading().kind === 'ready' && attempts().length === 0}>
            <Text style={{ color: C.muted }}>
              {tr(
                'No model usage is recorded for this turn in this conversation. Copied and imported history does not add model charges.',
              )}
            </Text>
          </If>
          <If when={reading().kind === 'ready' && attempts().length > 0}>
            <Text style={{ color: C.muted }}>
              {tr(
                attempts().length === 1
                  ? '{count} main model request in this turn'
                  : '{count} main model requests in this turn',
                { count: formatCount(attempts().length) },
              )}
            </Text>
            <Each of={counters()} key={(counter) => counter.key}>
              {(counter) => {
                const count = computed(() => total(attempts(), counter().key));
                return (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
                    <Text style={{ flex: 1, color: C.secondary }}>{counter().label}</Text>
                    <If
                      when={count() !== null}
                      else={<Text style={{ color: C.text }}>{tr('Unavailable')}</Text>}
                    >
                      <TokenCount
                        label={counter().label}
                        value={count()!.value}
                        format={(value) =>
                          withCoverage(value, count()!.reported, attempts().length)
                        }
                      />
                    </If>
                  </View>
                );
              }}
            </Each>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
              <Text style={{ flex: 1, color: C.secondary }}>{tr('Recorded cost')}</Text>
              <Text style={[{ color: C.text }, { userSelect: 'text' }]}>{cost()}</Text>
            </View>
            <Text style={{ color: C.muted }}>
              {tr('Auxiliary requests and tools are counted separately.')}
            </Text>
          </If>
        </View>
      </Scroll>
      <DialogFooter>
        <SettingsButton
          label={tr('Close')}
          accessibilityLabel={tr('Close turn usage')}
          autoFocus
          onPress={props.close}
        />
      </DialogFooter>
    </ModalDialog>
  );
}
