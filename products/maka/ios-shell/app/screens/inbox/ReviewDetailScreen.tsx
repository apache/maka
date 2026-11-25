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

import { cleanup, safeAreaInsets, Scroll, signal, Text, View, token } from 'nsh';
import { Input, NavPage } from 'nsh/base';
import { describeChildDecision, describePermissions } from '../../approval';
import { hostQuery, onSubscriptionItem, type AgentInteractionRecord } from '../../bridge';
import { ApprovalButton, ApprovalOutcome } from '../../ui/ApprovalCard';
import { tr } from '../../locale';
import { isInboxItemBusy, respondInboxItem, type InboxItem } from '../../state/inbox';
import { hapticSelection } from '../../state/preferences';
import { spacing, type } from '../../theme/tokens';
import { ActionButton, GroupRow, Icon, InsetGroup, ScreenHeader, StatusDot } from '../../ui';

function badgeLabel(kind: InboxItem['summary']['kind']): string {
  switch (kind) {
    case 'permissions':
      return tr('Permission');
    case 'service_approval':
      return tr('Service');
    case 'session_approval':
      return tr('Approval');
    case 'question':
      return tr('Question');
    case 'computer_app':
      return tr('Desktop App');
    case 'form':
      return tr('Form');
    default:
      return tr('Action Needed');
  }
}

function outcomeSummary(outcome: unknown): string {
  if (!outcome || typeof outcome !== 'object') return tr('Resolved on another device');
  const obj = outcome as Record<string, unknown>;
  const decision = typeof obj.decision === 'string' ? obj.decision : '';
  if (
    decision === 'allow' ||
    decision === 'approve' ||
    decision === 'once' ||
    decision === 'session'
  ) {
    return tr('Approved on another device');
  }
  if (decision === 'deny' || decision === 'reject') {
    return tr('Denied on another device');
  }
  return tr('Already resolved on another device');
}

export function ReviewDetailScreen(props: {
  item: InboxItem;
  onBack: () => void;
  onOpenConversation: (
    rootId: string,
    sessionId: string,
    hostName: string,
    sessionTitle: string,
  ) => void;
}) {
  const insets = safeAreaInsets();
  const liveRecord = signal<AgentInteractionRecord | null>(props.item.record);
  const selectedOption = signal<string | null>(null);
  const customAnswer = signal('');
  let disposed = false;

  const refreshAuthoritativeRecord = async () => {
    try {
      const latest = await hostQuery<AgentInteractionRecord | null>(
        'agent',
        'interaction',
        { sessionId: props.item.sessionId, requestId: props.item.requestId },
        undefined,
        props.item.rootId,
      );
      if (!disposed && latest) {
        liveRecord.set(latest);
      }
    } catch {
      // Keep current record on transient read failure.
    }
  };

  void refreshAuthoritativeRecord();

  const offSub = onSubscriptionItem((payload) => {
    if (disposed) return;
    if (payload.rootId && payload.rootId !== props.item.rootId) return;
    void refreshAuthoritativeRecord();
  });

  cleanup(() => {
    disposed = true;
    offSub();
  });

  const record = () => liveRecord() ?? props.item.record;
  const req = () => record()?.request;
  const settled = signal<{ title: string; accepted: boolean } | null>(null);
  const isResolvedRemotely = () => {
    const out = record()?.outcome;
    return !!settled() || (out !== null && out !== undefined);
  };
  const busy = () => isInboxItemBusy(props.item.key);

  const title = () => {
    const r = req();
    if (!r) return props.item.sessionTitle;
    switch (r.kind) {
      case 'permissions':
        return r.request.reason || tr('Additional permissions requested');
      case 'service_approval':
        return tr('Allow service call {name}?', { name: r.toolName || r.service });
      case 'question':
        return r.questions[0]?.question || tr('Question waiting for answer');
      case 'computer_app':
        return tr('Allow control of {name}?', { name: r.display.name });
      case 'session_approval':
        return tr('Approve delegated action?');
      case 'client_capability':
        return tr('Allow client capability?');
      default:
        return props.item.sessionTitle;
    }
  };

  const scopeDetail = (): { command?: string; permissions?: string } => {
    const r = req();
    if (!r) return {};
    if (r.kind === 'permissions') {
      return {
        command: r.request.command?.command || undefined,
        permissions: describePermissions(r.request.permissions) || undefined,
      };
    }
    if (r.kind === 'service_approval') {
      return { command: r.service + '.' + r.method + ' (' + r.binding + ')' };
    }
    if (r.kind === 'session_approval') {
      return { permissions: describeChildDecision(r.answer) || undefined };
    }
    if (r.kind === 'computer_app') {
      return { permissions: r.display.warning || r.display.appPath };
    }
    return {};
  };

  const allowPayload = (scope: 'once' | 'session'): Record<string, unknown> | null => {
    const r = req();
    if (!r) return null;
    switch (r.kind) {
      case 'permissions':
        return {
          kind: 'permissions',
          decision: { decision: 'allow', scope, permissions: r.request.permissions },
        };
      case 'service_approval':
        return { kind: 'service_approval', decision: 'allow' };
      case 'client_capability':
        return { kind: 'client_capability', decision: 'allow' };
      case 'computer_app':
        return { kind: 'computer_app', decision: scope };
      case 'session_approval':
        return { kind: 'session_approval', decision: 'approve' };
      default:
        return null;
    }
  };

  const denyPayload = (): Record<string, unknown> | null => {
    const r = req();
    if (!r || r.kind === 'question' || r.kind === 'form') return null;
    if (r.kind === 'permissions') return { kind: 'permissions', decision: { decision: 'deny' } };
    return { kind: r.kind, decision: 'deny' };
  };

  const submitAnswer = async (payload: Record<string, unknown>, kind: 'success' | 'warning') => {
    if (isResolvedRemotely() || busy()) return;
    const ok = await respondInboxItem(props.item, payload, kind);
    if (ok) {
      const request = req();
      if (request?.kind === 'question' || request?.kind === 'form') {
        props.onBack();
      } else {
        settled.set({
          title: kind === 'success' ? tr('Allowed') : tr('Denied'),
          accepted: kind === 'success',
        });
      }
      await refreshAuthoritativeRecord();
    }
  };

  const questionItem = () => {
    const r = req();
    return r?.kind === 'question' ? r.questions[0] : null;
  };

  return (
    <NavPage
      style={{ flex: 1 }}
      title={badgeLabel(props.item.summary.kind)}
      hidesBottomBarWhenPushed
      headerShadowVisible={false}
      header={
        <ScreenHeader
          title={badgeLabel(props.item.summary.kind)}
          backLabel={tr('Pending')}
          onBack={props.onBack}
        />
      }
    >
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        <Scroll
          style={{ flex: 1 }}
          keyboardDismissMode="interactive"
          contentStyle={{
            paddingTop: 16,
            paddingBottom: Math.max(insets().bottom, 20) + 28,
          }}
        >
          {/* Authoritative Remote Resolution Banner */}
          <If when={isResolvedRemotely()}>
            <View style={{ paddingHorizontal: spacing.pageX, marginBottom: 16 }}>
              <ApprovalOutcome
                title={settled()?.title ?? outcomeSummary(record()?.outcome)}
                accepted={
                  settled()?.accepted ??
                  outcomeSummary(record()?.outcome) === tr('Approved on another device')
                }
              />
            </View>
          </If>

          {/* Source Attribution */}
          <InsetGroup header={tr('Source')}>
            <GroupRow
              leading={<Icon name="laptop" color={token('primary')} size={18} />}
              title={props.item.hostName}
              subtitle={[props.item.workspaceName, props.item.sessionTitle]
                .filter(Boolean)
                .join(' · ')}
              chevron
              accessibilityLabel={tr('Open Conversation')}
              onPress={() =>
                props.onOpenConversation(
                  props.item.rootId,
                  props.item.sessionId,
                  props.item.hostName,
                  props.item.sessionTitle,
                )
              }
            />
          </InsetGroup>

          {/* Request Details */}
          <InsetGroup header={tr('Request details')}>
            <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <StatusDot kind={isResolvedRemotely() ? 'online' : 'waiting'} size={7} />
                <Text
                  style={{
                    ...type.caption,
                    fontWeight: '600',
                    color: isResolvedRemotely() ? token('success') : token('warning'),
                  }}
                >
                  {isResolvedRemotely() ? tr('Resolved') : badgeLabel(props.item.summary.kind)}
                </Text>
              </View>
              <Text style={{ ...type.headline, color: token('foreground') }}>{title()}</Text>

              <If when={scopeDetail().command}>
                <View
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    borderCurve: 'continuous',
                    backgroundColor: token('grouped-bg'),
                  }}
                >
                  <Text style={{ ...type.mono, color: token('foreground') }}>
                    {scopeDetail().command}
                  </Text>
                </View>
              </If>

              <If when={scopeDetail().permissions}>
                <View
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    borderCurve: 'continuous',
                    backgroundColor: token('grouped-bg'),
                  }}
                >
                  <Text style={{ ...type.subheadline, color: token('foreground') }}>
                    {scopeDetail().permissions}
                  </Text>
                </View>
              </If>
            </View>
          </InsetGroup>

          {/* Interactive Question Choices */}
          <If when={questionItem() && !isResolvedRemotely()}>
            <InsetGroup header={tr('Choose an answer')}>
              <Each of={questionItem()!.options} key={(o) => o.label}>
                {(opt, index) => (
                  <GroupRow
                    title={opt().label}
                    subtitle={opt().description}
                    trailing={
                      selectedOption() === opt().label ? (
                        <Icon name="check" color={token('primary')} size={18} strokeWidth={2.4} />
                      ) : undefined
                    }
                    divider={index() < questionItem()!.options.length - 1}
                    onPress={() => {
                      hapticSelection();
                      selectedOption.set(opt().label);
                      customAnswer.set('');
                    }}
                  />
                )}
              </Each>
            </InsetGroup>

            <InsetGroup header={tr('Or write your own')}>
              <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
                <Input
                  accessibilityLabel={tr('Write your own answer')}
                  value={customAnswer()}
                  placeholder={tr('Or type a custom answer…')}
                  onChange={({ value }) => {
                    customAnswer.set(value);
                    if (value.trim()) selectedOption.set(null);
                  }}
                  style={{
                    minHeight: 40,
                    ...type.body,
                    color: token('foreground'),
                    placeholderColor: token('muted-foreground'),
                    backgroundColor: 'transparent',
                  }}
                />
              </View>
            </InsetGroup>

            <View style={{ paddingHorizontal: spacing.pageX, gap: 10 }}>
              <ActionButton
                title={tr('Submit Answer')}
                disabled={busy() || (!selectedOption() && !customAnswer().trim())}
                onPress={() => {
                  const answerText = customAnswer().trim() || selectedOption() || '';
                  void submitAnswer(
                    {
                      kind: 'question',
                      answers: [{ question: questionItem()!.question, answer: answerText }],
                    },
                    'success',
                  );
                }}
              />
            </View>
          </If>

          {/* Approval Actions (hidden/disabled once resolved remotely) */}
          <If
            when={
              !isResolvedRemotely() && !questionItem() && (allowPayload('once') || denyPayload())
            }
          >
            <View
              style={{
                paddingHorizontal: spacing.pageX,
                gap: 8,
                flexDirection: 'row',
                flexWrap: 'wrap',
              }}
            >
              <If when={allowPayload('once')}>
                <ApprovalButton
                  title={tr('Allow once')}
                  kind="allow"
                  busy={busy()}
                  onPress={() => void submitAnswer(allowPayload('once')!, 'success')}
                />
              </If>
              <If when={req()?.kind === 'permissions' || req()?.kind === 'computer_app'}>
                <ApprovalButton
                  title={tr('This session')}
                  kind="session"
                  busy={busy()}
                  onPress={() => void submitAnswer(allowPayload('session')!, 'success')}
                />
              </If>
              <If when={denyPayload()}>
                <ApprovalButton
                  title={tr('Deny')}
                  kind="deny"
                  busy={busy()}
                  onPress={() => void submitAnswer(denyPayload()!, 'warning')}
                />
              </If>
            </View>
          </If>

          {/* Open Conversation Shortcut */}
          <View style={{ paddingHorizontal: spacing.pageX, marginTop: 14 }}>
            <ActionButton
              title={tr('Open Conversation')}
              variant="quiet"
              onPress={() =>
                props.onOpenConversation(
                  props.item.rootId,
                  props.item.sessionId,
                  props.item.hostName,
                  props.item.sessionTitle,
                )
              }
            />
          </View>
        </Scroll>
      </View>
    </NavPage>
  );
}
