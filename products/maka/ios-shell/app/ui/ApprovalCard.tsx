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

import { cleanup, reduceMotion, signal, Text, View, token } from 'nsh';
import { spacing, type } from '../theme/tokens';
import { Button } from 'nsh/base';
import { tr } from '../locale';
import { hapticImpact } from '../state/preferences';
import { Icon } from './Icon';
import { GroupDivider } from './InsetGroup';
import { StatusDot } from './StatusDot';

export function ApprovalButton(props: {
  title: string;
  kind: 'allow' | 'session' | 'deny';
  busy?: boolean;
  weight: number;
  onPress: () => void;
}) {
  const color = () =>
    token(
      props.kind === 'allow'
        ? 'primary-foreground'
        : props.kind === 'deny'
          ? 'approval-reject'
          : 'primary',
    );
  return (
    <Button
      accessibilityLabel={props.title}
      disabled={props.busy}
      onPress={() => {
        hapticImpact('light');
        props.onPress();
      }}
      class={
        reduceMotion()
          ? 'active:opacity-85 disabled:opacity-45'
          : 'active:scale-[0.96] active:opacity-85 disabled:opacity-45 transition duration-150'
      }
      style={{
        minHeight: 44,
        flex: props.weight,
        minWidth: 0,
        paddingHorizontal: 5,
        paddingVertical: 8,
        borderRadius: 13,
        borderCurve: 'continuous',
        backgroundColor: token(
          props.kind === 'allow'
            ? 'primary'
            : props.kind === 'deny'
              ? 'surface-muted'
              : 'approval-session-bg',
        ),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
      }}
    >
      <If when={props.kind === 'allow'}>
        <Icon name="check" size={14} color={color()} />
      </If>
      <Text
        style={{
          ...type.footnote,
          numberOfLines: 1,
          textOverflow: 'ellipsis',
          fontWeight: '600',
          color: color(),
          flexShrink: 1,
          textAlign: 'center',
        }}
      >
        {props.title}
      </Text>
    </Button>
  );
}

export function approvalFeedback<T = boolean>() {
  const outcome = signal<T | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  cleanup(() => {
    alive = false;
    clearTimeout(timer);
  });
  return {
    outcome,
    show(accepted: T) {
      if (!alive) return;
      clearTimeout(timer);
      outcome.set(accepted);
      timer = setTimeout(() => outcome.set(null), 3000);
    },
  };
}

export function ApprovalFeedback(props: { accepted: boolean | null }) {
  return (
    <If when={props.accepted !== null}>
      <ApprovalOutcome
        title={props.accepted ? tr('Allowed') : tr('Denied')}
        accepted={props.accepted === true}
      />
    </If>
  );
}

export function ApprovalOutcome(props: { title: string; accepted: boolean }) {
  const color = () => token(props.accepted ? 'approval-accepted' : 'muted-foreground');
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: spacing.pillRadius,
        backgroundColor: token(props.accepted ? 'approval-accepted-bg' : 'surface-muted'),
      }}
    >
      <Icon name={props.accepted ? 'checkCircle' : 'xCircle'} size={14} color={color()} />
      <Text style={{ ...type.footnote, color: color() }}>{props.title}</Text>
    </View>
  );
}

export function ApprovalActions(props: {
  allowLabel?: string;
  denyLabel?: string;
  onAllow?: () => void;
  onDeny?: () => void;
  onAllowSession?: () => void;
  busy?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <If when={props.onDeny && props.denyLabel}>
        <ApprovalButton
          title={props.denyLabel!}
          kind="deny"
          weight={props.onAllowSession ? 0.72 : 1}
          busy={props.busy}
          onPress={props.onDeny!}
        />
      </If>
      <If when={props.onAllowSession}>
        <ApprovalButton
          title={tr('This session')}
          kind="session"
          weight={1.04}
          busy={props.busy}
          onPress={props.onAllowSession!}
        />
      </If>
      <If when={props.onAllow && props.allowLabel}>
        <ApprovalButton
          title={props.allowLabel!}
          kind="allow"
          weight={props.onAllowSession ? 1.24 : 1}
          busy={props.busy}
          onPress={props.onAllow!}
        />
      </If>
    </View>
  );
}

export function ApprovalCard(props: {
  badge: string;
  timestamp?: string;
  sourceLine: string;
  title: string;
  detail?: string;
  monospaceDetail?: boolean;
  busy?: boolean;
  allowLabel?: string;
  denyLabel?: string;
  accepted?: boolean;
  inline?: boolean;
  onAllowSession?: () => void;
  onAllow?: () => void;
  onDeny?: () => void;
  onPress?: () => void;
  divider?: boolean;
}) {
  return (
    <View>
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 14,
          gap: 10,
        }}
      >
        <View
          role={props.onPress ? 'button' : undefined}
          onPress={props.onPress}
          style={{ gap: 6 }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 6,
                borderCurve: 'continuous',
                backgroundColor: token('warning-tint'),
              }}
            >
              <StatusDot kind="waiting" size={6} />
              <Text
                style={{
                  ...type.caption,
                  fontWeight: '600',
                  color: token('warning'),
                }}
              >
                {props.badge}
              </Text>
            </View>
            <If when={props.timestamp}>
              <Text
                style={{
                  ...type.caption,
                  fontVariant: ['tabular-nums'],
                  color: token('tertiary-foreground'),
                }}
              >
                {props.timestamp}
              </Text>
            </If>
          </View>

          <If when={props.sourceLine}>
            <Text
              style={{
                ...type.footnote,
                color: token('muted-foreground'),
                numberOfLines: 1,
                textOverflow: 'ellipsis',
              }}
            >
              {props.sourceLine}
            </Text>
          </If>
          <Text
            style={{
              ...type.headline,
              color: token('foreground'),
              numberOfLines: 2,
              textOverflow: 'ellipsis',
            }}
          >
            {props.title}
          </Text>

          <If when={props.detail}>
            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: 8,
                borderCurve: 'continuous',
                backgroundColor: token(props.inline ? 'inline-command' : 'grouped-bg'),
              }}
            >
              <Text
                style={{
                  ...(props.monospaceDetail ? type.mono : type.subheadline),
                  color: token('foreground'),
                  numberOfLines: 3,
                  textOverflow: 'ellipsis',
                }}
              >
                {props.detail}
              </Text>
            </View>
          </If>
        </View>

        <If
          when={props.accepted !== undefined}
          else={
            <If when={props.onAllow || props.onDeny}>
              <ApprovalActions
                allowLabel={props.allowLabel}
                denyLabel={props.denyLabel}
                busy={props.busy}
                onAllow={props.onAllow}
                onAllowSession={props.onAllowSession}
                onDeny={props.onDeny}
              />
            </If>
          }
        >
          <ApprovalFeedback accepted={props.accepted ?? null} />
        </If>
      </View>
      <If when={props.divider}>
        <GroupDivider inset={spacing.pageX} />
      </If>
    </View>
  );
}
