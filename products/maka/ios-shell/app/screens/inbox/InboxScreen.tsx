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
import {
  approvalControls,
  approvalDetail,
  approvalOutcome,
  interactionBadge,
  interactionTitle,
} from '../../approval';
import { approvalFeedback } from '../../ui/ApprovalCard';
import { tr } from '../../locale';
import { savedHosts } from '../../state/hostPool';
import {
  allInboxItems,
  inboxLoading,
  inboxError,
  isInboxItemBusy,
  refreshAllInbox,
  respondInboxItem,
  type InboxItem,
} from '../../state/inbox';
import { hapticSelection } from '../../state/preferences';
import { spacing } from '../../theme/tokens';
import {
  ApprovalCard,
  BannerNotice,
  EmptyState,
  InsetGroup,
  ScopePills,
  ScreenHeader,
  type ScopePillItem,
} from '../../ui';

type CategoryFilter = 'all' | 'approvals' | 'questions';

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
    const result = await respondInboxItem(item, answer);
    const accepted = approvalOutcome(result?.outcome);
    if (accepted !== null) feedback.show({ item, index, accepted });
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
          <If when={inboxError()}>
            <BannerNotice
              tone="warning"
              title={tr('Could not sync Pending')}
              detail={inboxError() ?? undefined}
              actionLabel={tr('Retry')}
              onAction={refreshAllInbox}
            />
          </If>
          <If
            when={visibleItems().length > 0}
            else={
              <View style={{ flex: 1, justifyContent: 'center' }}>
                <If when={!inboxError()}>
                  <If
                    when={inboxLoading()}
                    else={
                      <EmptyState
                        icon="checkCircle"
                        tint="success"
                        title={tr('All caught up')}
                        subtitle={
                          savedHosts().length > 1
                            ? tr(
                                'No approvals or questions are waiting across your connected computers.',
                              )
                            : tr('No approvals or questions are waiting.')
                        }
                      />
                    }
                  >
                    <BannerNotice title={tr('Loading…')} />
                  </If>
                </If>
              </View>
            }
          >
            <InsetGroup header={tr('Waiting for your response')}>
              <Each of={visibleItems()} key={(item) => item.key}>
                {(item, index) => {
                  const detail = () =>
                    item().record ? approvalDetail(item().record!.request) : {};
                  const controls = () => approvalControls(item().record?.request);
                  const allow = () => controls().primary;
                  const allowSession = () => controls().session;
                  const deny = () => controls().deny;
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
                      title={interactionTitle(item().record?.request, item().sessionTitle)}
                      detail={[detail().command, detail().permissions].filter(Boolean).join('\n')}
                      monospaceDetail={!detail().permissions}
                      busy={isInboxItemBusy(item().key)}
                      allowLabel={allow()?.label}
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
                        allow() ? () => void respond(item(), allow()!.answer, 'success') : undefined
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
