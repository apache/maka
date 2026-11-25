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

import { cleanup, effect, untracked, Scroll, signal, Text, View, token } from 'nsh';
import { Input, MenuButton, Sheet, type MenuButtonItem, type SheetDetent } from 'nsh/base';
import { isAvailable, SegmentedControl } from 'nsh/mobile';
import {
  hasAgentEndpoint,
  hostMutate,
  type AgentModelChoice,
  type AgentWorkspaceSelection,
} from '../../bridge';
import { tr } from '../../locale';
import {
  activeHostInfo,
  connectedHosts,
  hostById,
  savedHosts,
  selectedScopeRootId,
} from '../../state/hostPool';
import { hapticNotification, hapticSelection } from '../../state/preferences';
import {
  createHostSession,
  allSessions,
  listHostDirectoryRoots,
  listHostProjects,
  listHostModels,
  type ScopedSession,
} from '../../state/sessions';
import type { ServiceMethods } from '../../../../../../packages/plugin-sdk/src/generated/methods';
import { settingsRpc } from '../../state/settings/rpc';
import { SettingChoice } from '../settings/SettingsForm';
import { spacing, type } from '../../theme/tokens';
import { ActionButton, BannerNotice, GroupRow, Icon, InsetGroup, StatusDot } from '../../ui';

interface WorkspaceOption {
  id: string;
  label: string;
  subtitle: string;
  selection: AgentWorkspaceSelection;
}

let lastUsedRootId: string | undefined;

export function NewChatSheet(props: {
  open: boolean;
  onClose: () => void;
  onCreated: (session: ScopedSession) => void;
}) {
  const detent = signal<SheetDetent>('large');
  const targetRootId = signal('');
  const modeIndex = signal(0);
  const title = signal('');
  const workspaces = signal<WorkspaceOption[]>([]);
  const selectedWorkspaceId = signal('');
  const models = signal<AgentModelChoice[]>([]);
  const defaultModel = signal('');
  const modelIndex = signal('');
  const presets = signal<ServiceMethods['agent']['presets']['output']>([]);
  const memberIds = signal<string[]>([]);
  const createdRoom = signal<ScopedSession | null>(null);
  const ready = signal(false);
  const loadingWorkspaces = signal(false);
  const loadingPresets = signal(false);
  const creating = signal(false);
  const error = signal<string | null>(null);
  const eligibleHosts = () =>
    connectedHosts().filter(({ connection }) => hasAgentEndpoint(connection));
  const eligible = (id: string) => eligibleHosts().some(({ host }) => host.rootId === id);

  effect(() => {
    if (!props.open) return;
    detent.set(untracked(savedHosts).length === 1 ? 'medium' : 'large');
    const scope = untracked(selectedScopeRootId);
    const hosts = untracked(eligibleHosts);
    const preferred =
      hosts.find(({ host }) => host.rootId === scope) ??
      hosts.find(({ host }) => host.rootId === lastUsedRootId) ??
      hosts[0];
    targetRootId.set(preferred?.host.rootId ?? '');
  });
  effect(() => {
    const rootId = targetRootId();
    const generation = activeHostInfo(rootId)?.generation;
    if (!props.open || !rootId) return;
    let cancelled = false;
    cleanup(() => {
      cancelled = true;
    });
    error.set(null);
    workspaces.set([]);
    selectedWorkspaceId.set('');
    models.set([]);
    defaultModel.set('');
    modelIndex.set('');
    loadingWorkspaces.set(true);
    ready.set(false);
    const current = () => !cancelled && generation === activeHostInfo(rootId)?.generation;
    const rpc = settingsRpc(rootId);
    const settings = activeHostInfo(rootId)?.endpoints.includes('settings');
    void Promise.all([
      listHostProjects(rootId, current),
      listHostDirectoryRoots(rootId),
      listHostModels(rootId, current),
      settings ? rpc.query('settings', 'connections', { kind: 'start' }) : undefined,
    ])
      .then(async ([projects, roots, choices, catalog]) => {
        if (!current()) return;
        const target = catalog?.kind === 'ready' ? catalog.defaultTarget : null;
        const model = target ? await rpc.query('settings', 'resolveModel', target) : null;
        if (!current()) return;
        const opts: WorkspaceOption[] = projects.map((project) => ({
          id: 'proj:' + project.reference.id,
          label: project.name,
          subtitle: project.path,
          selection: { kind: 'project', projectId: project.reference.id, path: project.path },
        }));
        const paths = new Set(opts.map((option) => option.subtitle));
        for (const root of roots) {
          if (!paths.has(root.path))
            opts.push({
              id: 'dir:' + root.path,
              label: root.name,
              subtitle: root.path,
              selection: { kind: 'directory', path: root.path },
            });
        }
        workspaces.set(opts);
        selectedWorkspaceId.set(opts[0]?.id ?? '');
        models.set(choices);
        ready.set(true);
        if (model?.kind === 'ready') defaultModel.set(model.choice.label);
      })
      .catch((cause) => {
        if (!cancelled) error.set(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) loadingWorkspaces.set(false);
      });
  });
  effect(() => {
    const rootId = targetRootId();
    presets.set([]);
    memberIds.set([]);
    loadingPresets.set(false);
    if (!props.open || !rootId || modeIndex() !== 1) return;
    let cancelled = false;
    cleanup(() => {
      cancelled = true;
    });
    loadingPresets.set(true);
    void settingsRpc(rootId)
      .query('agent', 'presets', {})
      .then((rows) => {
        if (!cancelled) presets.set(rows.filter((row) => row.availability.kind === 'available'));
      })
      .catch((cause) => {
        if (!cancelled) error.set(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) loadingPresets.set(false);
      });
  });

  const selectedHostName = () => hostById(targetRootId())?.hostName ?? tr('Offline');
  const hostMenuItems = (): MenuButtonItem[] =>
    savedHosts().map((host) => ({
      id: host.rootId,
      label: host.hostName,
      checked: host.rootId === targetRootId(),
      singleSelection: true,
      disabled: !eligible(host.rootId),
    }));
  const candidates = () => [
    ...presets().map((preset) => ({ id: 'preset:' + preset.id, title: preset.name })),
    ...allSessions()
      .filter(
        (item) =>
          item.rootId === targetRootId() && item.session.kind === 'agent' && !item.session.archived,
      )
      .map(({ session }) => ({ id: 'session:' + session.id, title: session.title })),
  ];
  const reset = () => {
    targetRootId.set('');
    createdRoom.set(null);
    title.set('');
    modeIndex.set(0);
    ready.set(false);
    error.set(null);
    props.onClose();
  };
  const close = () => {
    if (!creating()) reset();
  };
  const finish = (created: ScopedSession) => {
    lastUsedRootId = created.rootId;
    hapticNotification('success');
    reset();
    props.onCreated(created);
  };

  const handleCreate = async () => {
    const rootId = targetRootId();
    if (
      !rootId ||
      !eligible(rootId) ||
      creating() ||
      loadingWorkspaces() ||
      loadingPresets() ||
      !ready()
    )
      return;
    const isRoom = modeIndex() === 1;
    const members = memberIds();
    const selectedPresets = presets();
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
        backend: modelIndex() === '' ? null : models()[Number(modelIndex())]?.selection,
      });
      if (isRoom && members.length) {
        createdRoom.set(created);
        const sessionIds: string[] = [];
        for (const id of members) {
          if (id.startsWith('session:')) sessionIds.push(id.slice(8));
          else {
            const preset = selectedPresets.find((row) => row.id === id.slice(7))!;
            const member = await createHostSession({
              rootId,
              kind: 'agent',
              title: preset.name,
              automaticTitle: false,
              workspace,
              presetId: preset.id,
            });
            sessionIds.push(member.session.id);
          }
        }
        await hostMutate(
          'agent',
          'roomManage',
          {
            sessionId: created.session.id,
            action: { kind: 'add_members', memberSessionIds: sessionIds },
          },
          { rootId },
        );
      }
      finish(created);
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
      closeOnSwipe={!creating()}
      onOpenChange={({ open }) => {
        if (!open) close();
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
          onPress={close}
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

        {/* Target Computer */}
        <If when={savedHosts().length > 1}>
          <InsetGroup elevated header={tr('Target computer')}>
            <MenuButton
              accessibilityLabel={tr('Target computer')}
              title={tr('Target computer')}
              items={hostMenuItems()}
              disabled={creating() || !!createdRoom()}
              onSelect={({ id }) => {
                if (!eligible(id)) return;
                hapticSelection();
                targetRootId.set(id);
              }}
            >
              <GroupRow
                leading={
                  <StatusDot kind={eligible(targetRootId()) ? 'online' : 'offline'} size={8} />
                }
                title={selectedHostName()}
                chevron
              />
            </MenuButton>
          </InsetGroup>
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

        <If when={modeIndex() === 0}>
          <InsetGroup elevated>
            <SettingChoice
              title={tr('Model')}
              value={modelIndex()}
              disabled={loadingWorkspaces() || creating()}
              options={[
                { id: '', label: defaultModel() || tr('Default') },
                ...models().map((model, index) => ({ id: String(index), label: model.label })),
              ]}
              change={modelIndex.set}
            />
          </InsetGroup>
        </If>

        <If when={modeIndex() === 1}>
          <InsetGroup elevated header={tr('Room members')}>
            <If when={loadingPresets()}>
              <GroupRow title={tr('Loading…')} />
            </If>
            <Each of={candidates()} key={(item) => item.id}>
              {(item, index) => (
                <GroupRow
                  title={item().title}
                  divider={index() < candidates().length - 1}
                  disabled={creating() || !!createdRoom()}
                  trailing={
                    memberIds().includes(item().id) ? (
                      <Icon name="check" size={16} color={token('primary')} />
                    ) : undefined
                  }
                  onPress={() =>
                    memberIds.update((ids) =>
                      ids.includes(item().id)
                        ? ids.filter((id) => id !== item().id)
                        : [...ids, item().id],
                    )
                  }
                />
              )}
            </Each>
          </InsetGroup>
        </If>

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
            minHeight={46}
            title={
              createdRoom()
                ? tr('Open Conversation')
                : savedHosts().length > 1 && !creating()
                  ? modeIndex() === 1
                    ? tr('Create Room on {name}', { name: selectedHostName() })
                    : tr('Start Chat on {name}', { name: selectedHostName() })
                  : creating()
                    ? tr('Creating…')
                    : modeIndex() === 1
                      ? tr('Create Room')
                      : tr('Start Chat')
            }
            disabled={
              creating() ||
              (!createdRoom() &&
                (!eligible(targetRootId()) || loadingWorkspaces() || loadingPresets() || !ready()))
            }
            onPress={() => {
              if (creating()) return;
              const room = createdRoom();
              if (room) finish(room);
              else void handleCreate();
            }}
          />
        </View>
      </Scroll>
    </Sheet>
  );
}
