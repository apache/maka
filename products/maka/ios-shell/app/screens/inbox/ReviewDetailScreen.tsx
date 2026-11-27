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

import { cleanup, effect, untracked, safeAreaInsets, Scroll, signal, Text, View, token } from 'nsh';
import { Input, NavPage } from 'nsh/base';
import {
  approvalControls,
  approvalDetail,
  approvalOutcome,
  interactionBadge,
  interactionTitle,
} from '../../approval';
import {
  hostQuery,
  watchHost,
  type AgentDeliveryPage,
  type AgentInteractionRecord,
} from '../../bridge';
import { ApprovalActions, ApprovalOutcome } from '../../ui/ApprovalCard';
import { QuestionForm } from '../../ui/QuestionForm';
import { tr } from '../../locale';
import { isInboxItemBusy, respondInboxItem, type InboxItem } from '../../state/inbox';
import { activeHostInfo } from '../../state/hostPool';
import { hapticSelection } from '../../state/preferences';
import { spacing, type } from '../../theme/tokens';
import { ActionButton, GroupRow, Icon, InsetGroup, ScreenHeader, StatusDot } from '../../ui';

function outcomeSummary(
  outcome: import('../../../../../../packages/plugin-sdk/src/generated/runtime').InteractionOutcome,
): string {
  const approved = approvalOutcome(outcome);
  return approved === null
    ? tr('Already resolved on another device')
    : approved
      ? tr('Approved on another device')
      : tr('Denied on another device');
}

let reviewSequence = 0;

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
  let disposed = false;
  let read = 0;

  const refreshAuthoritativeRecord = async () => {
    const request = ++read;
    const generation = activeHostInfo(props.item.rootId)?.generation;
    try {
      const latest = await hostQuery<AgentInteractionRecord | null>(
        'agent',
        'interaction',
        { sessionId: props.item.sessionId, requestId: props.item.requestId },
        undefined,
        props.item.rootId,
      );
      if (
        !disposed &&
        request === read &&
        latest &&
        activeHostInfo(props.item.rootId)?.generation === generation
      ) {
        liveRecord.set(latest);
      }
    } catch {
      // Keep current record on transient read failure.
    }
  };

  effect(() => {
    const { rootId, sessionId } = props.item;
    const connection = activeHostInfo(rootId);
    if (!connection) return;
    untracked(() => void refreshAuthoritativeRecord());
    cleanup(
      watchHost<AgentDeliveryPage>(
        rootId,
        connection.generation,
        'review:' + ++reviewSequence,
        'watch',
        { sessionId, after: 0 },
        (page) => {
          if (page.kind === 'interactions' && !liveRecord()?.outcome)
            void refreshAuthoritativeRecord();
        },
        (cause) => console.warn('Could not watch review', cause),
      ),
    );
  });
  cleanup(() => {
    disposed = true;
  });

  const record = () => liveRecord() ?? props.item.record;
  const req = () => record()?.request;
  const settled = signal<{ title: string; accepted: boolean } | null>(null);
  const isResolvedRemotely = () => {
    const out = record()?.outcome;
    return !!settled() || (out !== null && out !== undefined);
  };
  const busy = () => isInboxItemBusy(props.item.key);

  const title = () => interactionTitle(req(), props.item.sessionTitle);

  const scopeDetail = () => (req() ? approvalDetail(req()!) : {});
  const controls = () => approvalControls(req());

  const submitAnswer = async (payload: Record<string, unknown>, kind: 'success' | 'warning') => {
    if (isResolvedRemotely() || busy()) return;
    const result = await respondInboxItem(props.item, payload);
    if (result) {
      const request = req();
      if (request?.kind === 'question' || request?.kind === 'form') {
        props.onBack();
      } else {
        const accepted = approvalOutcome(result.outcome);
        if (accepted !== null)
          settled.set({ title: accepted ? tr('Allowed') : tr('Denied'), accepted });
      }
      await refreshAuthoritativeRecord();
    }
  };

  const questions = () => {
    const r = req();
    return r?.kind === 'question' ? r.questions : null;
  };

  return (
    <NavPage
      style={{ flex: 1 }}
      title={interactionBadge(props.item.summary.kind)}
      hidesBottomBarWhenPushed
      headerShadowVisible={false}
      header={
        <ScreenHeader
          title={interactionBadge(props.item.summary.kind)}
          backLabel={tr('Pending')}
          onBack={props.onBack}
        />
      }
    >
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        <Scroll
          style={{ flex: 1 }}
          contentStyle={{
            paddingTop: 16,
            paddingBottom: Math.max(insets().bottom, 20) + 28,
          }}
        >
          {/* Authoritative Remote Resolution Banner */}
          <If when={isResolvedRemotely()}>
            <View style={{ paddingHorizontal: spacing.pageX, marginBottom: 16 }}>
              <ApprovalOutcome
                title={
                  settled()?.title ??
                  outcomeSummary(
                    record()
                      ?.outcome as import('../../../../../../packages/plugin-sdk/src/generated/runtime').InteractionOutcome,
                  )
                }
                accepted={
                  settled()?.accepted ??
                  outcomeSummary(
                    record()
                      ?.outcome as import('../../../../../../packages/plugin-sdk/src/generated/runtime').InteractionOutcome,
                  ) === tr('Approved on another device')
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
              <If when={!isResolvedRemotely()}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <StatusDot kind={'waiting'} size={7} />
                  <Text
                    style={{
                      ...type.caption,
                      fontWeight: '600',
                      color: token('warning'),
                    }}
                  >
                    {interactionBadge(props.item.summary.kind)}
                  </Text>
                </View>
              </If>
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

          <If when={questions() && !isResolvedRemotely()}>
            <QuestionForm
              questions={questions()!}
              busy={busy()}
              submit={(answer) => void submitAnswer(answer, 'success')}
            />
          </If>

          {/* Approval Actions (hidden/disabled once resolved remotely) */}
          <If
            when={!isResolvedRemotely() && !questions() && (controls().primary || controls().deny)}
          >
            <View style={{ paddingHorizontal: spacing.pageX }}>
              <ApprovalActions
                allowLabel={controls().primary?.label}
                denyLabel={tr('Deny')}
                busy={busy()}
                onAllow={
                  controls().primary
                    ? () => void submitAnswer(controls().primary!.answer, 'success')
                    : undefined
                }
                onDeny={
                  controls().deny ? () => void submitAnswer(controls().deny!, 'warning') : undefined
                }
                onAllowSession={
                  controls().session
                    ? () => void submitAnswer(controls().session!, 'success')
                    : undefined
                }
              />
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
