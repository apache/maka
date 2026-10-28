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

import { textTooltip } from './ui';
import { UiError, errorText, renderText, type UiText } from './text';
import { tr } from './locale';
import { cleanup, inputAction, Scroll, signal, Text, View } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import type {
  ModelUsage,
  ServiceMethods,
  SettingsUsageRead,
  UsageActivityCursor,
  UsageFence,
  UsageModelAttempt,
} from '../../../../packages/plugin-sdk/src/index.js';
import { host } from './host';
import { C, controlStyle, controlHoverStyle, controlFocusStyle } from './ui';
import { Icon } from './Icon';
import { dialogTop } from './chrome';

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

function total(attempts: UsageModelAttempt[], key: Counter): string {
  let value = 0;
  for (const attempt of attempts) {
    const next: ModelUsage[Counter] = attempt.usage[key];
    if (typeof next !== 'number' || next < 0 || !Number.isSafeInteger(next))
      return tr('Unavailable');
    value += next;
    if (!Number.isSafeInteger(value)) return tr('Unavailable');
  }
  return String(value);
}

/** Read original turn accounting at one captured usage fence, including across retries. */
export function TurnUsage(props: {
  sessionId: string;
  turnId: string;
  current(): boolean;
  close(): void;
}) {
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
        checked += page.attempts.length;
        if (
          (fence !== null &&
            (page.through.stateDomain !== fence.stateDomain ||
              page.through.partitions.some(
                (position, index) => position !== fence.partitions[index],
              ))) ||
          !Number.isSafeInteger(page.total) ||
          page.total < 0 ||
          (expectedTotal !== null && page.total !== expectedTotal) ||
          checked > page.total ||
          (page.nextCursor === null
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
            origin.invocation.session_id === props.sessionId &&
            origin.invocation.turn_id === props.turnId
          )
            matching.push(attempt);
        }
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
        reading.set({ kind: 'loading', checked });
      }
      reading.set({ kind: 'ready', attempts: matching });
    } catch (reason) {
      if (active())
        reading.set({
          kind: 'failed',
          message: errorText(reason),
        });
    }
  };
  void Promise.resolve().then(read);
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
  const cost = () => {
    let value = 0;
    for (const attempt of attempts()) {
      if (attempt.costUsd == null || !Number.isFinite(attempt.costUsd)) return tr('Unavailable');
      value += attempt.costUsd;
      if (!Number.isFinite(value)) return tr('Unavailable');
    }
    return `$${value.toFixed(6)}`;
  };
  return (
    <Dialog
      animation="none"
      closeOnEscape={false}
      closeOnBackdropPress={false}
      closeOnSwipe={false}
      onCancel={props.close}
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
        paddingTop: dialogTop(16),
        backgroundColor: '#00000099',
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 560,
          maxHeight: '100%',
          padding: 16,
          gap: 16,
          backgroundColor: C.surface,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 16,
        }}
      >
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
          <Text style={{ flex: 1, color: C.text, fontWeight: '700' }}>
            {tr('Main model usage')}
          </Text>
          <Button
            ref={(node) => node.focus()}
            accessibilityLabel={tr('Close turn usage')}
            tooltip={textTooltip(() => tr('Close'))}
            onPress={props.close}
            style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
          >
            <Icon name="close" color={C.secondary} />
            <Text style={{ color: C.accent }}>{tr('Close')}</Text>
          </Button>
        </View>
        <Scroll style={{ flexShrink: 1, minHeight: 0 }}>
          <View style={{ gap: 8 }}>
            <If when={reading().kind === 'loading'}>
              <Text style={{ color: C.muted }}>
                {tr('Reading original usage… {count} records checked', {
                  count:
                    reading().kind === 'loading'
                      ? (reading() as Extract<Reading, { kind: 'loading' }>).checked
                      : 0,
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
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
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
                  { count: attempts().length },
                )}
              </Text>
              <Each of={counters()} key={(counter) => counter.key}>
                {(counter) => (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
                    <Text style={{ flex: 1, color: C.secondary }}>{counter().label}</Text>
                    <Text style={[{ color: C.text }, { userSelect: 'text' }]}>
                      {total(attempts(), counter().key)}
                    </Text>
                  </View>
                )}
              </Each>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
                <Text style={{ flex: 1, color: C.secondary }}>{tr('Recorded cost')}</Text>
                <Text style={[{ color: C.text }, { userSelect: 'text' }]}>{cost()}</Text>
              </View>
              <Text style={{ color: C.muted }}>
                {tr(
                  'Missing provider counters or prices are unavailable. Auxiliary requests and tools are counted separately.',
                )}
              </Text>
            </If>
          </View>
        </Scroll>
      </View>
    </Dialog>
  );
}
