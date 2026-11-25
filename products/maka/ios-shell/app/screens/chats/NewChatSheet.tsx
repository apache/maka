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

import { effect, Scroll, signal, Text, View, token } from 'nsh';
import { Input, MenuButton, Sheet, type MenuButtonItem, type SheetDetent } from 'nsh/base';
import { isAvailable, SegmentedControl } from 'nsh/mobile';
import { hasAgentEndpoint, type AgentProject, type AgentWorkspaceSelection } from '../../bridge';
import { tr } from '../../locale';
import { connectedHosts, selectedScopeRootId } from '../../state/hostPool';
import { hapticNotification, hapticSelection } from '../../state/preferences';
import {
  createHostSession,
  listHostDirectoryRoots,
  listHostProjects,
  type ScopedSession,
} from '../../state/sessions';
import { spacing, type } from '../../theme/tokens';
import { ActionButton, BannerNotice, GroupRow, Icon, InsetGroup, StatusDot } from '../../ui';

interface WorkspaceOption {
  id: string;
  label: string;
  subtitle: string;
  selection: AgentWorkspaceSelection;
}

export function NewChatSheet(props: {
  open: boolean;
  onClose: () => void;
  onCreated: (session: ScopedSession) => void;
}) {
  const detent = signal<SheetDetent>('large');
  const targetRootId = signal<string>('');
  const modeIndex = signal(0); // 0 = Chat, 1 = Room
  const title = signal('');
  const workspaces = signal<WorkspaceOption[]>([]);
  const selectedWorkspaceId = signal<string>('');
  const loadingWorkspaces = signal(false);
  const creating = signal(false);
  const error = signal<string | null>(null);

  const eligibleHosts = () =>
    connectedHosts().filter((entry) => hasAgentEndpoint(entry.connection));

  effect(() => {
    if (!props.open) return;
    error.set(null);
    const hosts = eligibleHosts();
    if (!hosts.length) return;
    const scope = selectedScopeRootId();
    const cur = targetRootId();
    if (!cur || !hosts.some((h) => h.host.rootId === cur)) {
      const preferred = hosts.find((h) => h.host.rootId === scope) ?? hosts[0];
      targetRootId.set(preferred.host.rootId);
    }
  });

  effect(() => {
    const rootId = targetRootId();
    if (!props.open || !rootId) return;
    let cancelled = false;
    loadingWorkspaces.set(true);
    void Promise.all([listHostProjects(rootId), listHostDirectoryRoots(rootId)]).then(
      ([projects, roots]) => {
        if (cancelled) return;
        const opts: WorkspaceOption[] = [];
        for (const p of projects as AgentProject[]) {
          opts.push({
            id: 'proj:' + p.reference.id,
            label: p.name,
            subtitle: p.path,
            selection: { kind: 'project', projectId: p.reference.id, path: p.path },
          });
        }
        for (const r of roots) {
          if (opts.some((o) => o.subtitle === r.path)) continue;
          opts.push({
            id: 'dir:' + r.path,
            label: r.name,
            subtitle: r.path,
            selection: { kind: 'directory', path: r.path },
          });
        }
        workspaces.set(opts);
        if (opts.length && !opts.some((o) => o.id === selectedWorkspaceId())) {
          selectedWorkspaceId.set(opts[0].id);
        }
        loadingWorkspaces.set(false);
      },
      () => {
        if (!cancelled) loadingWorkspaces.set(false);
      },
    );
    return () => {
      cancelled = true;
    };
  });

  const selectedHostName = () =>
    eligibleHosts().find((h) => h.host.rootId === targetRootId())?.host.hostName ?? '';

  const hostMenuItems = (): MenuButtonItem[] =>
    eligibleHosts().map((h) => ({
      id: h.host.rootId,
      label: h.host.hostName,
      checked: h.host.rootId === targetRootId(),
      singleSelection: true,
    }));

  const handleCreate = async () => {
    const rootId = targetRootId();
    if (!rootId || creating()) return;
    const isRoom = modeIndex() === 1;
    const picked = workspaces().find((w) => w.id === selectedWorkspaceId());
    const workspace: AgentWorkspaceSelection = picked
      ? picked.selection
      : { kind: 'directory', path: '.' };
    const cleanTitle = title().trim();
    creating.set(true);
    error.set(null);
    try {
      const created = await createHostSession({
        rootId,
        kind: isRoom ? 'room' : 'agent',
        title: cleanTitle || (isRoom ? tr('New Room') : tr('New Chat')),
        automaticTitle: !isRoom && !cleanTitle,
        workspace,
      });
      hapticNotification('success');
      title.set('');
      props.onClose();
      props.onCreated(created);
    } catch (cause) {
      hapticNotification('error');
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      creating.set(false);
    }
  };

  return (
    <Sheet
      open={props.open}
      accessibilityLabel={tr('New Chat')}
      detents={['medium', 'large']}
      detent={detent()}
      onDetentChange={(e) => detent.set(e.detent)}
      grabber
      closeOnSwipe
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      backdropStyle={{ backgroundColor: token('scrim') }}
      popupStyle={{
        backgroundColor: token('grouped-bg'),
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        borderCurve: 'continuous',
        paddingTop: 4,
      }}
      grabberStyle={{
        width: 36,
        height: 5,
        borderRadius: 3,
        alignSelf: 'center',
        backgroundColor: token('tertiary-foreground'),
        marginTop: 6,
        marginBottom: 4,
      }}
    >
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: spacing.pageX,
          paddingTop: 6,
          paddingBottom: 12,
        }}
      >
        <Text style={{ ...type.headline, color: token('foreground') }}>
          {modeIndex() === 1 ? tr('New Room') : tr('New Chat')}
        </Text>
        <View
          role="button"
          accessibilityLabel={tr('Cancel')}
          onPress={props.onClose}
          class="active:opacity-60"
          style={{ minHeight: 36, paddingHorizontal: 8, justifyContent: 'center' }}
        >
          <Text style={{ ...type.bodyMedium, color: token('primary') }}>{tr('Cancel')}</Text>
        </View>
      </View>

      <Scroll
        style={{ flex: 1 }}
        keyboardDismissMode="interactive"
        contentStyle={{ paddingBottom: 36 }}
      >
        <If when={error()}>
          <BannerNotice tone="destructive" title={error()!} />
        </If>

        {/* Chat vs Room Segmented Control */}
        <View style={{ paddingHorizontal: spacing.pageX, marginBottom: 18 }}>
          <If
            when={isAvailable}
            else={
              <View
                style={{
                  flexDirection: 'row',
                  backgroundColor: token('surface-muted'),
                  borderRadius: 10,
                  padding: 3,
                  gap: 4,
                }}
              >
                <View
                  role="button"
                  accessibilityLabel={tr('Chat')}
                  onPress={() => modeIndex.set(0)}
                  style={{
                    flex: 1,
                    minHeight: 34,
                    borderRadius: 8,
                    backgroundColor: modeIndex() === 0 ? token('surface') : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ ...type.subheadlineMedium, color: token('foreground') }}>
                    {tr('Chat')}
                  </Text>
                </View>
                <View
                  role="button"
                  accessibilityLabel={tr('Room')}
                  onPress={() => modeIndex.set(1)}
                  style={{
                    flex: 1,
                    minHeight: 34,
                    borderRadius: 8,
                    backgroundColor: modeIndex() === 1 ? token('surface') : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ ...type.subheadlineMedium, color: token('foreground') }}>
                    {tr('Room')}
                  </Text>
                </View>
              </View>
            }
          >
            <SegmentedControl
              items={[{ title: tr('Chat') }, { title: tr('Room') }]}
              selectedIndex={modeIndex()}
              onChange={({ index }) => {
                hapticSelection();
                modeIndex.set(index);
              }}
              style={{ height: 34 }}
            />
          </If>
        </View>

        {/* Target Computer */}
        <If when={eligibleHosts().length > 0}>
          <InsetGroup elevated header={tr('Target computer')}>
            <MenuButton
              accessibilityLabel={tr('Target computer')}
              title={tr('Target computer')}
              items={hostMenuItems()}
              onSelect={({ id }) => {
                hapticSelection();
                targetRootId.set(id);
              }}
            >
              <GroupRow
                leading={<StatusDot kind="online" size={8} />}
                title={selectedHostName()}
                chevron={eligibleHosts().length > 1}
              />
            </MenuButton>
          </InsetGroup>
        </If>

        {/* Workspace / Project Picker */}
        <InsetGroup elevated header={tr('Workspace')}>
          <If
            when={workspaces().length > 0}
            else={
              <GroupRow
                title={loadingWorkspaces() ? tr('Loading workspaces…') : tr('Default workspace')}
              />
            }
          >
            <Each of={workspaces()} key={(w) => w.id}>
              {(w, index) => (
                <GroupRow
                  leading={<Icon name="folder" color={token('primary')} size={18} />}
                  title={w().label}
                  subtitle={w().subtitle}
                  trailing={
                    selectedWorkspaceId() === w().id ? (
                      <Icon name="check" color={token('primary')} size={18} strokeWidth={2.4} />
                    ) : undefined
                  }
                  divider={index() < workspaces().length - 1}
                  onPress={() => {
                    hapticSelection();
                    selectedWorkspaceId.set(w().id);
                  }}
                />
              )}
            </Each>
          </If>
        </InsetGroup>

        {/* Optional Title */}
        <InsetGroup elevated header={tr('Title (optional)')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
            <Input
              accessibilityLabel={tr('Conversation title')}
              value={title()}
              placeholder={
                modeIndex() === 1 ? tr('Name this room') : tr('Leave blank for automatic title')
              }
              onChange={({ value }) => title.set(value)}
              style={{
                minHeight: 38,
                ...type.body,
                color: token('foreground'),
                placeholderColor: token('muted-foreground'),
                backgroundColor: 'transparent',
              }}
            />
          </View>
        </InsetGroup>

        <View style={{ paddingHorizontal: spacing.pageX }}>
          <ActionButton
            title={
              creating()
                ? tr('Creating…')
                : modeIndex() === 1
                  ? tr('Create Room')
                  : tr('Start Chat')
            }
            disabled={creating() || !targetRootId()}
            onPress={() => void handleCreate()}
          />
        </View>
      </Scroll>
    </Sheet>
  );
}
