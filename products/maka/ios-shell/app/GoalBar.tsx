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

import { signal, Text, View } from 'nsh';
import type { AgentGoalDetail } from './bridge';
import { token } from 'nsh';
import { tr } from './locale';

function goalStatusLabel(status: string): string {
  switch (status) {
    case 'armed':
      return tr('Ready to start');
    case 'active':
      return tr('Working');
    case 'paused':
      return tr('Paused');
    case 'blocked':
      return tr('Needs attention');
    case 'budget_limited':
      return tr('Budget reached');
    case 'achieved':
      return tr('Achieved');
    case 'cancelled':
      return tr('Cancelled');
    default:
      return status;
  }
}

function formatElapsed(sec: number): string {
  const seconds = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
  if (seconds < 60) return tr('{seconds}s', { seconds });
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return tr('{minutes}m {seconds}s', { minutes: mins, seconds: seconds % 60 });
  return tr('{hours}h {minutes}m', { hours: Math.floor(mins / 60), minutes: mins % 60 });
}

/**
 * Docked Goal status & control bar pinned above the Composer, matching Maka Desktop.
 */
export function GoalBar(props: {
  goal: () => AgentGoalDetail | null;
  busy: () => boolean;
  onControl: (action: 'pause' | 'resume' | 'cancel' | 'dismiss') => void;
}) {
  const expanded = signal(false);

  const visible = () => {
    const g = props.goal();
    return g !== null && !g.dismissed;
  };
  const isTerminal = () => {
    const st = props.goal()?.status;
    return st === 'achieved' || st === 'cancelled';
  };
  const dotColor = () => {
    const st = props.goal()?.status;
    if (st === 'active') return token('working');
    if (st === 'achieved') return token('success');
    if (st === 'blocked') return token('destructive');
    return token('subdued');
  };
  const shortObjective = () => {
    const obj = props.goal()?.objective ?? '';
    return obj.length > 42 ? obj.slice(0, 42) + '…' : obj;
  };
  const metricsText = () => {
    const g = props.goal();
    if (!g) return '';
    const iteration = tr('Iteration {count}', { count: g.iterations });
    const elapsed = formatElapsed(g.elapsedSeconds);
    return g.tokenBudget
      ? tr('{iteration} · Elapsed: {elapsed} · Budget: {budget}', {
          iteration,
          elapsed,
          budget: g.tokenBudget,
        })
      : tr('{iteration} · Elapsed: {elapsed}', { iteration, elapsed });
  };

  return (
    <If when={visible()}>
      <View
        style={{
          marginHorizontal: 12,
          marginBottom: 6,
          borderRadius: 16,
          backgroundColor: token('card'),
          borderWidth: 1,
          borderColor: token('border'),
          overflow: 'hidden',
        }}
      >
        <View
          role="button"
          accessibilityLabel={tr('Toggle goal details')}
          onPress={() => expanded.set(!expanded())}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 9,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: dotColor(),
            }}
          />
          <Text style={{ fontSize: 12.5, fontWeight: '600', color: token('foreground') }}>
            {tr('Goal · {status}', { status: goalStatusLabel(props.goal()?.status ?? '') })}
          </Text>
          <Text style={{ flex: 1, fontSize: 12, color: token('muted-foreground') }}>
            {shortObjective()}
          </Text>
          <Text style={{ fontSize: 12, color: token('subdued') }}>{expanded() ? '▾' : '▴'}</Text>
        </View>

        <If when={expanded()}>
          <View
            style={{
              paddingHorizontal: 12,
              paddingBottom: 11,
              gap: 8,
              borderTopWidth: 1,
              borderTopColor: token('border'),
              paddingTop: 9,
            }}
          >
            <Text style={{ fontSize: 13, lineHeight: 19, color: token('foreground') }}>
              {props.goal()?.objective ?? ''}
            </Text>

            <Text style={{ fontSize: 11.5, color: token('subdued') }}>{metricsText()}</Text>

            <If when={(props.goal()?.note ?? '').trim().length > 0}>
              <Text style={{ fontSize: 12, lineHeight: 17.5, color: token('muted-foreground') }}>
                {props.goal()?.note ?? ''}
              </Text>
            </If>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <If when={props.goal()?.status === 'active'}>
                <View
                  role="button"
                  accessibilityLabel={tr('Pause Goal')}
                  onPress={() => {
                    if (!props.busy()) props.onControl('pause');
                  }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 10,
                    backgroundColor: token('muted'),
                    borderWidth: 1,
                    borderColor: token('border'),
                  }}
                >
                  <Text style={{ fontSize: 12.5, fontWeight: '600', color: token('foreground') }}>
                    {tr('Pause')}
                  </Text>
                </View>
              </If>

              <If when={props.goal()?.status === 'paused' || props.goal()?.status === 'blocked'}>
                <View
                  role="button"
                  accessibilityLabel={tr('Resume Goal')}
                  onPress={() => {
                    if (!props.busy()) props.onControl('resume');
                  }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 10,
                    backgroundColor: token('primary'),
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12.5,
                      fontWeight: '600',
                      color: token('primary-foreground'),
                    }}
                  >
                    {tr('Resume')}
                  </Text>
                </View>
              </If>

              <If when={!isTerminal()}>
                <View
                  role="button"
                  accessibilityLabel={tr('Cancel Goal')}
                  onPress={() => {
                    if (!props.busy()) props.onControl('cancel');
                  }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 10,
                    backgroundColor: token('destructive-soft'),
                  }}
                >
                  <Text style={{ fontSize: 12.5, fontWeight: '600', color: token('destructive') }}>
                    {tr('Cancel Goal')}
                  </Text>
                </View>
              </If>

              <If when={isTerminal()}>
                <View
                  role="button"
                  accessibilityLabel={tr('Dismiss Goal')}
                  onPress={() => {
                    if (!props.busy()) props.onControl('dismiss');
                  }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 10,
                    backgroundColor: token('muted'),
                    borderWidth: 1,
                    borderColor: token('border'),
                  }}
                >
                  <Text
                    style={{ fontSize: 12.5, fontWeight: '600', color: token('muted-foreground') }}
                  >
                    {tr('Dismiss')}
                  </Text>
                </View>
              </If>
            </View>
          </View>
        </If>
      </View>
    </If>
  );
}
