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

import { safeAreaInsets, Scroll, signal, View, token } from 'nsh';
import { NavPage } from 'nsh/base';
import { isAvailable, SegmentedControl } from 'nsh/mobile';
import { describeChildDecision, describePermissions } from '../../approval';
import { approvalFeedback } from '../../ui/ApprovalCard';
import { tr } from '../../locale';
import { savedHosts } from '../../state/hostPool';
import {
  allInboxItems,
  inboxLoading,
  isInboxItemBusy,
  refreshAllInbox,
  respondInboxItem,
  type InboxItem,
} from '../../state/inbox';
import { hapticSelection } from '../../state/preferences';
import { spacing } from '../../theme/tokens';
import {
  ApprovalCard,
  EmptyState,
  InsetGroup,
  ScopePills,
  ScreenHeader,
  type ScopePillItem,
} from '../../ui';

type CategoryFilter = 'all' | 'approvals' | 'questions';

function interactionBadge(kind: InboxItem['summary']['kind']): string {
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

function interactionTitle(item: InboxItem): string {
  const req = item.record?.request;
  if (!req) return item.sessionTitle;
  switch (req.kind) {
    case 'permissions':
      return req.request.reason || tr('Additional permissions requested');
    case 'service_approval':
      return tr('Allow service call {name}?', { name: req.toolName || req.service });
    case 'question':
      return req.questions[0]?.question || tr('Question waiting for answer');
    case 'computer_app':
      return tr('Allow control of {name}?', { name: req.display.name });
    case 'session_approval':
      return tr('Approve delegated action?');
    case 'client_capability':
      return tr('Allow client capability?');
    default:
      return item.sessionTitle;
  }
}

function interactionDetail(item: InboxItem): { text?: string; mono?: boolean } {
  const req = item.record?.request;
  if (!req) return {};
  if (req.kind === 'permissions') {
    if (req.request.command?.command) {
      return { text: req.request.command.command, mono: true };
    }
    const summary = describePermissions(req.request.permissions);
    return summary ? { text: summary, mono: false } : {};
  }
  if (req.kind === 'session_approval') {
    const desc = describeChildDecision(req.answer);
    return desc ? { text: desc, mono: false } : {};
  }
  if (req.kind === 'service_approval') {
    return { text: req.service + '.' + req.method, mono: true };
  }
  return {};
}

function buildAllowAnswer(
  item: InboxItem,
  scope: 'once' | 'session' = 'once',
): Record<string, unknown> | null {
  const req = item.record?.request;
  if (!req) return null;
  switch (req.kind) {
    case 'permissions':
      return {
        kind: 'permissions',
        decision: {
          decision: 'allow',
          scope,
          permissions: req.request.permissions,
        },
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
}

function buildDenyAnswer(item: InboxItem): Record<string, unknown> | null {
  const req = item.record?.request;
  if (!req) return null;
  switch (req.kind) {
    case 'permissions':
      return { kind: 'permissions', decision: { decision: 'deny' } };
    case 'service_approval':
      return { kind: 'service_approval', decision: 'deny' };
    case 'client_capability':
      return { kind: 'client_capability', decision: 'deny' };
    case 'computer_app':
      return { kind: 'computer_app', decision: 'deny' };
    case 'session_approval':
      return { kind: 'session_approval', decision: 'deny' };
    default:
      return null;
  }
}

export function InboxScreen(props: { onOpenItem: (item: InboxItem) => void }) {
  const insets = safeAreaInsets();
  const category = signal<CategoryFilter>('all');

  const feedback = approvalFeedback<{ item: InboxItem; index: number; accepted: boolean }>();
  const respond = async (
    item: InboxItem,
    answer: Record<string, unknown>,
    kind: 'success' | 'warning',
  ) => {
    const index = allInboxItems().findIndex(({ key }) => key === item.key);
    if (await respondInboxItem(item, answer, kind))
      feedback.show({ item, index, accepted: kind === 'success' });
  };

  const visibleItems = () => {
    const previous = feedback.outcome();
    const list = [...allInboxItems()];
    if (previous && !list.some(({ key }) => previous.item.key === key))
      list.splice(Math.max(0, previous.index), 0, previous.item);
    if (category() === 'questions') {
      return list.filter((i) => i.summary.kind === 'question');
    }
    if (category() === 'approvals') {
      return list.filter((i) => i.summary.kind !== 'question');
    }
    return list;
  };

  const categoryItems = (): ScopePillItem[] => {
    const all = allInboxItems();
    const qCount = all.filter((i) => i.summary.kind === 'question').length;
    const aCount = all.length - qCount;
    return [
      { id: 'all', label: tr('All'), count: all.length },
      { id: 'approvals', label: tr('Approvals'), count: aCount },
      { id: 'questions', label: tr('Questions'), count: qCount },
    ];
  };

  return (
    <NavPage
      style={{ flex: 1 }}
      title={tr('Pending')}
      headerLargeTitle
      headerTransparent
      headerBackgroundOnScroll
      headerShadowVisible={false}
      header={<ScreenHeader title={tr('Pending')} large />}
    >
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        <Scroll
          style={{ flex: 1 }}
          refreshing={inboxLoading()}
          onRefresh={() => void refreshAllInbox()}
          contentStyle={{
            flexGrow: 1,
            paddingTop: 8,
            paddingBottom: insets().bottom + spacing.tabBarClearance,
          }}
        >
          <If
            when={isAvailable}
            else={
              <ScopePills
                items={categoryItems()}
                selectedId={category()}
                onSelect={(id) => {
                  hapticSelection();
                  category.set(id as CategoryFilter);
                }}
              />
            }
          >
            <View style={{ paddingHorizontal: spacing.pageX, marginBottom: 12 }}>
              <SegmentedControl
                items={categoryItems().map((item) => ({ title: item.label }))}
                selectedIndex={categoryItems().findIndex((item) => item.id === category())}
                onChange={({ index }) => {
                  hapticSelection();
                  category.set(categoryItems()[index].id as CategoryFilter);
                }}
              />
            </View>
          </If>
          <If
            when={visibleItems().length > 0}
            else={
              <View style={{ flex: 1, justifyContent: 'center' }}>
                <EmptyState
                  icon="checkCircle"
                  tint="success"
                  title={tr('All caught up')}
                  subtitle={
                    savedHosts().length > 1
                      ? tr('No approvals or questions are waiting across your connected computers.')
                      : tr('No approvals or questions are waiting.')
                  }
                />
              </View>
            }
          >
            <InsetGroup header={tr('Waiting for your response')}>
              <Each of={visibleItems()} key={(item) => item.key}>
                {(item, index) => {
                  const detail = () => interactionDetail(item());
                  const allow = () => buildAllowAnswer(item());
                  const allowSession = () => {
                    const kind = item().record?.request.kind;
                    return kind === 'permissions' || kind === 'computer_app'
                      ? buildAllowAnswer(item(), 'session')
                      : null;
                  };
                  const deny = () => buildDenyAnswer(item());
                  const source = () =>
                    [
                      savedHosts().length > 1 ? item().hostName : '',
                      item().workspaceName || item().sessionTitle,
                    ]
                      .filter(Boolean)
                      .join(' · ');
                  return (
                    <ApprovalCard
                      badge={interactionBadge(item().summary.kind)}
                      sourceLine={source()}
                      title={interactionTitle(item())}
                      detail={detail().text}
                      monospaceDetail={detail().mono}
                      busy={isInboxItemBusy(item().key)}
                      allowLabel={
                        allow() ? (allowSession() ? tr('Allow once') : tr('Allow')) : undefined
                      }
                      accepted={
                        feedback.outcome()?.item.key === item().key
                          ? feedback.outcome()?.accepted
                          : undefined
                      }
                      onAllowSession={
                        allowSession()
                          ? () => void respond(item(), allowSession()!, 'success')
                          : undefined
                      }
                      denyLabel={deny() ? tr('Deny') : undefined}
                      onAllow={
                        allow() ? () => void respond(item(), allow()!, 'success') : undefined
                      }
                      onDeny={deny() ? () => void respond(item(), deny()!, 'warning') : undefined}
                      onPress={
                        feedback.outcome()?.item.key === item().key
                          ? undefined
                          : () => props.onOpenItem(item())
                      }
                      divider={index() < visibleItems().length - 1}
                    />
                  );
                }}
              </Each>
            </InsetGroup>
          </If>
        </Scroll>
      </View>
    </NavPage>
  );
}
