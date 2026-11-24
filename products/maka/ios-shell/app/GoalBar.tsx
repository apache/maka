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

function goalStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return '正在推进';
    case 'paused':
      return '已暂停';
    case 'blocked':
      return '等待处理';
    case 'achieved':
      return '已达成';
    case 'cancelled':
      return '已取消';
    default:
      return status;
  }
}

function formatElapsed(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  if (sec < 60) return String(Math.floor(sec)) + 's';
  const mins = Math.floor(sec / 60);
  const rem = Math.floor(sec % 60);
  if (mins < 60) return String(mins) + 'm ' + String(rem) + 's';
  const hrs = Math.floor(mins / 60);
  return String(hrs) + 'h ' + String(mins % 60) + 'm';
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
    return (
      '第 ' +
      String(g.iterations) +
      ' 轮 · 已运行 ' +
      formatElapsed(g.elapsedSeconds) +
      (g.tokenBudget ? ' · 预算 ' + String(g.tokenBudget) : '')
    );
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
          accessibilityLabel="Toggle goal details"
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
            {'目标 · ' + goalStatusLabel(props.goal()?.status ?? '')}
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
                  accessibilityLabel="Pause goal"
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
                    暂停
                  </Text>
                </View>
              </If>

              <If when={props.goal()?.status === 'paused' || props.goal()?.status === 'blocked'}>
                <View
                  role="button"
                  accessibilityLabel="Resume goal"
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
                    继续推进
                  </Text>
                </View>
              </If>

              <If when={!isTerminal()}>
                <View
                  role="button"
                  accessibilityLabel="Cancel goal"
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
                    取消目标
                  </Text>
                </View>
              </If>

              <If when={isTerminal()}>
                <View
                  role="button"
                  accessibilityLabel="Dismiss goal"
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
                    收起
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
