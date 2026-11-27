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

import {
  cleanup,
  computed,
  effect,
  keyboardFrame,
  safeAreaInsets,
  Scroll,
  signal,
  Text,
  token,
  untracked,
  View,
} from 'nsh';
import { NavPage } from 'nsh/base';
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
import { QuestionFields, questionDraft } from '../../ui/QuestionForm';
import { tr } from '../../locale';
import { activeHostInfo, hostById } from '../../state/hostPool';
import { isInboxItemBusy, respondInboxItem, type InboxItem } from '../../state/inbox';
import { spacing, type } from '../../theme/tokens';
import { ActionButton, GroupRow, Icon, InsetGroup, ScreenHeader, StatusDot } from '../../ui';
import { glassSurfaceStyle } from '../../ui/Glass';

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
  const draft = questionDraft();
  const hostName = () => hostById(props.item.rootId)?.hostName ?? props.item.hostName;
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

  const connectionGeneration = computed(() => activeHostInfo(props.item.rootId)?.generation);
  effect(() => {
    const { rootId, sessionId } = props.item;
    const generation = connectionGeneration();
    if (generation === undefined) return;
    untracked(() => void refreshAuthoritativeRecord());
    cleanup(
      watchHost<AgentDeliveryPage>(
        rootId,
        generation,
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

  const submitAnswer = async (payload: Record<string, unknown>) => {
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

  const showActions = () =>
    !isResolvedRemotely() && (questions() || controls().primary || controls().deny);

  return (
    <NavPage
      style={{ flex: 1 }}
      title={interactionBadge(props.item.summary.kind)}
      hidesBottomBarWhenPushed
      headerTransparent
      headerBackgroundOnScroll
      headerShadowVisible={false}
      header={
        <ScreenHeader
          title={interactionBadge(props.item.summary.kind)}
          backLabel={tr('Pending')}
          onBack={props.onBack}
        />
      }
    >
      <ReviewContent />
    </NavPage>
  );

  function ReviewContent() {
    const insets = safeAreaInsets();
    const actionsHeight = signal(0);
    const keyboardHeight = () => keyboardFrame().height;
    const bottom = () => (keyboardHeight() || insets().bottom) + 8;
    return (
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        <Scroll
          testID="review-details"
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          contentStyle={{
            paddingTop: insets().top + 16,
            paddingLeft: Math.max(0, insets().left - spacing.pageX),
            paddingRight: Math.max(0, insets().right - spacing.pageX),
            paddingBottom: bottom() + (showActions() ? actionsHeight() + 8 : 12),
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
              title={hostName()}
              subtitle={[props.item.workspaceName, props.item.sessionTitle]
                .filter(Boolean)
                .join(' · ')}
              chevron
              accessibilityLabel={tr('Open Conversation')}
              onPress={() =>
                props.onOpenConversation(
                  props.item.rootId,
                  props.item.sessionId,
                  hostName(),
                  props.item.sessionTitle,
                )
              }
            />
          </InsetGroup>

          {/* Request Details */}
          <If when={!questions() || isResolvedRemotely()}>
            <InsetGroup header={tr('Request details')}>
              <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 10 }}>
                <If when={!isResolvedRemotely()}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <StatusDot kind={'waiting'} size={7} />
                    <Text
                      style={{
                        ...type.caption,
                        fontWeight: '600',
                        color: token('warning-foreground'),
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
          </If>

          <If when={questions() && !isResolvedRemotely()}>
            <QuestionFields
              questions={questions()!}
              busy={busy()}
              draft={draft}
              surface="grouped"
            />
          </If>

          {/* Open Conversation Shortcut */}
          <View style={{ paddingHorizontal: spacing.pageX, marginTop: 14 }}>
            <ActionButton
              testID="review-open-conversation"
              title={tr('Open Conversation')}
              variant="glassQuiet"
              onPress={() =>
                props.onOpenConversation(
                  props.item.rootId,
                  props.item.sessionId,
                  hostName(),
                  props.item.sessionTitle,
                )
              }
            />
          </View>
        </Scroll>
        <If when={showActions()}>
          <View
            testID="review-actions"
            onLayout={({ bounds }) => actionsHeight.set(Math.ceil(bounds.size.height))}
            style={{
              ...glassSurfaceStyle(20),
              position: 'absolute',
              left: Math.max(spacing.pageX, insets().left),
              right: Math.max(spacing.pageX, insets().right),
              bottom: 8,
              marginBottom: keyboardHeight() > 0 ? 'env(keyboard-inset-height)' : insets().bottom,
              padding: 6,
            }}
          >
            <If
              when={questions()}
              else={
                <ApprovalActions
                  floating
                  allowLabel={controls().primary?.label}
                  denyLabel={tr('Deny')}
                  busy={busy()}
                  onAllow={
                    controls().primary
                      ? () => void submitAnswer(controls().primary!.answer)
                      : undefined
                  }
                  onDeny={controls().deny ? () => void submitAnswer(controls().deny!) : undefined}
                  onAllowSession={
                    controls().session ? () => void submitAnswer(controls().session!) : undefined
                  }
                />
              }
            >
              <ActionButton
                title={tr('Submit Answer')}
                variant="glassPrimary"
                compact
                minHeight={spacing.rowMinHeight}
                disabled={busy()}
                onPress={() => void submitAnswer(draft.answer(questions()!.length))}
              />
            </If>
          </View>
        </If>
      </View>
    );
  }
}
