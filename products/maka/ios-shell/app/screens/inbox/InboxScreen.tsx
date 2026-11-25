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

import { safeAreaInsets, Scroll, Text, View, token } from 'nsh';
import { NavPage } from 'nsh/base';
import { describeChildDecision, describePermissions } from '../../approval';
import { tr } from '../../locale';
import { hostStatusKind, savedHosts, selectedScopeRootId, selectScope } from '../../state/hostPool';
import {
  filteredInboxItems,
  inboxLoading,
  isInboxItemBusy,
  pendingCountForHost,
  refreshAllInbox,
  respondInboxItem,
  type InboxItem,
} from '../../state/inbox';
import { spacing, type } from '../../theme/tokens';
import {
  ActionButton,
  ApprovalCard,
  EmptyState,
  InsetGroup,
  ScopePills,
  ScreenHeader,
  type ScopePillItem,
} from '../../ui';

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

function buildAllowAnswer(item: InboxItem): Record<string, unknown> | null {
  const req = item.record?.request;
  if (!req) return null;
  switch (req.kind) {
    case 'permissions':
      return {
        kind: 'permissions',
        decision: {
          decision: 'allow',
          scope: 'once',
          permissions: req.request.permissions,
        },
      };
    case 'service_approval':
      return { kind: 'service_approval', decision: 'allow' };
    case 'client_capability':
      return { kind: 'client_capability', decision: 'allow' };
    case 'computer_app':
      return { kind: 'computer_app', decision: 'once' };
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

  const scopeItems = (): ScopePillItem[] => [
    { id: 'all', label: tr('All Computers') },
    ...savedHosts().map((host) => ({
      id: host.rootId,
      label: host.hostName,
      status: hostStatusKind(host.rootId),
      count: pendingCountForHost(host.rootId),
    })),
  ];

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
          contentContainerStyle={{
            paddingTop: 8,
            paddingBottom: insets().bottom + spacing.tabBarClearance,
          }}
        >
          <If when={savedHosts().length > 0}>
            <ScopePills
              items={scopeItems()}
              selectedId={selectedScopeRootId()}
              onSelect={selectScope}
            />
          </If>

          <If
            when={filteredInboxItems().length > 0}
            else={
              <EmptyState
                icon="checkCircle"
                tint="success"
                title={tr('All caught up')}
                subtitle={tr(
                  'No approvals or questions are waiting across your connected computers.',
                )}
              />
            }
          >
            <InsetGroup header={tr('Waiting for your response')}>
              <Each of={filteredInboxItems()} key={(item) => item.key}>
                {(item, index) => {
                  const detail = () => interactionDetail(item());
                  const allow = () => buildAllowAnswer(item());
                  const deny = () => buildDenyAnswer(item());
                  const source = () =>
                    [item().hostName, item().workspaceName, item().sessionTitle]
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
                      allowLabel={allow() ? tr('Allow') : undefined}
                      denyLabel={deny() ? tr('Deny') : undefined}
                      onAllow={
                        allow()
                          ? () => void respondInboxItem(item(), allow()!, 'success')
                          : undefined
                      }
                      onDeny={
                        deny() ? () => void respondInboxItem(item(), deny()!, 'warning') : undefined
                      }
                      onPress={() => props.onOpenItem(item())}
                      divider={index() < filteredInboxItems().length - 1}
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

/** Review detail pushed from Tab 2 Pending card (M3 adds Diff linkage & full forms). */
export function ReviewDetailScreen(props: { item: InboxItem; onBack: () => void }) {
  const insets = safeAreaInsets();
  const detail = () => interactionDetail(props.item);
  const allow = () => buildAllowAnswer(props.item);
  const deny = () => buildDenyAnswer(props.item);

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
          contentContainerStyle={{
            paddingTop: 16,
            paddingBottom: Math.max(insets().bottom, 20) + 24,
          }}
        >
          <InsetGroup header={tr('Request details')}>
            <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 10 }}>
              <Text style={{ ...type.footnote, color: token('muted-foreground') }}>
                {[props.item.hostName, props.item.workspaceName, props.item.sessionTitle]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <Text style={{ ...type.headline, color: token('foreground') }}>
                {interactionTitle(props.item)}
              </Text>
              <If when={detail().text}>
                <View
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    borderCurve: 'continuous',
                    backgroundColor: token('grouped-bg'),
                  }}
                >
                  <Text
                    style={{
                      ...(detail().mono ? type.mono : type.subheadline),
                      color: token('foreground'),
                    }}
                  >
                    {detail().text}
                  </Text>
                </View>
              </If>
            </View>
          </InsetGroup>

          <If when={allow() || deny()}>
            <View style={{ paddingHorizontal: spacing.pageX, gap: 10 }}>
              <If when={allow()}>
                <ActionButton
                  title={tr('Allow once')}
                  disabled={isInboxItemBusy(props.item.key)}
                  onPress={async () => {
                    const ok = await respondInboxItem(props.item, allow()!, 'success');
                    if (ok) props.onBack();
                  }}
                />
              </If>
              <If when={deny()}>
                <ActionButton
                  title={tr('Deny')}
                  variant="destructive"
                  disabled={isInboxItemBusy(props.item.key)}
                  onPress={async () => {
                    const ok = await respondInboxItem(props.item, deny()!, 'warning');
                    if (ok) props.onBack();
                  }}
                />
              </If>
            </View>
          </If>
        </Scroll>
      </View>
    </NavPage>
  );
}
