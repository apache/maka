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

import { copy } from './copy';
import { Scroll, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { Switch } from 'nsh/mobile';
import {
  agentListDirectoryChildren,
  type AgentBackendPreference,
  type AgentModelChoice,
  type AgentProject,
  type AgentScheduledSummary,
  type AgentWorkspaceSelection,
  type HostStateSnapshot,
  type SavedHostItem,
} from './bridge';
import { token } from 'nsh';

export interface DiffLineItem {
  id: string;
  kind: 'header' | 'ctx' | 'add' | 'del';
  num: string;
  text: string;
  file: string;
}

/**
 * Parse a real GitWorkspaceDiff unified patch string (possibly spanning
 * multiple files via diff --git / +++ b/<path>) into quoteable DiffLineItems.
 */
export function parseUnifiedWorkspacePatch(patch: string, filterPath?: string): DiffLineItem[] {
  const out: DiffLineItem[] = [];
  if (!patch) return out;
  const raw = patch.split('\n');
  let currentFile = filterPath ?? 'workspace';
  let lineNo = 1;
  let emittedHeaderForFile = '';

  const includeCurrent = () =>
    !filterPath || currentFile === filterPath || currentFile.endsWith('/' + filterPath);

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.startsWith('diff --git ')) {
      const m = new RegExp('^diff --git a/(.+?) b/(.+)$').exec(line);
      if (m) {
        currentFile = m[2];
        lineNo = 1;
      }
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /\+(\d+)/.exec(line);
      if (m) lineNo = Number(m[1]);
      if (includeCurrent() && emittedHeaderForFile !== currentFile) {
        emittedHeaderForFile = currentFile;
        out.push({
          id: 'hdr:' + currentFile + ':' + String(i),
          kind: 'header',
          num: '',
          text: currentFile,
          file: currentFile,
        });
      }
      continue;
    }
    if (!includeCurrent()) continue;
    if (emittedHeaderForFile !== currentFile && line.length > 0) {
      emittedHeaderForFile = currentFile;
      out.push({
        id: 'hdr:' + currentFile + ':' + String(i),
        kind: 'header',
        num: '',
        text: currentFile,
        file: currentFile,
      });
    }
    const kind: DiffLineItem['kind'] = line.startsWith('+')
      ? 'add'
      : line.startsWith('-')
        ? 'del'
        : 'ctx';
    out.push({
      id: currentFile + ':' + String(i),
      kind,
      num: String(lineNo),
      text: line,
      file: currentFile,
    });
    if (kind !== 'del') lineNo += 1;
  }
  return out;
}

function scheduleStatusLabel(status: AgentScheduledSummary['status']): string {
  switch (status) {
    case 'active':
      return '运行中';
    case 'paused':
      return '已暂停';
    case 'completed':
      return '已完成';
    case 'expired':
      return '已过期';
  }
}

export function DiffOverlay(props: {
  title: () => string;
  lines: () => DiffLineItem[];
  truncatedNotice: () => string | null;
  onQuoteLine: (line: DiffLineItem) => void;
  onBack: () => void;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: token('background') }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: token('border'),
        }}
      >
        <View
          role="button"
          accessibilityLabel="Back from diff"
          onPress={props.onBack}
          style={{ minWidth: 44, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: token('foreground') }}>
            {copy('‹ Back', '‹ 返回', '‹ 返回')}
          </Text>
        </View>
        <Text style={{ fontSize: 15, fontWeight: '600', color: token('foreground') }}>
          {props.title()}
        </Text>
        <View style={{ minWidth: 44 }} />
      </View>

      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 9,
          borderBottomWidth: 1,
          borderBottomColor: token('border'),
          gap: 4,
        }}
      >
        <Text style={{ fontSize: 12.5, color: token('muted-foreground') }}>
          轻点任意一行可引用发给 Maka
        </Text>
        <If when={props.truncatedNotice() !== null}>
          <Text style={{ fontSize: 12, color: token('warning') }}>
            {props.truncatedNotice() ?? ''}
          </Text>
        </If>
      </View>

      <Scroll style={{ flex: 1 }} contentStyle={{ paddingVertical: 8, paddingBottom: 32 }}>
        <If when={props.lines().length === 0}>
          <View style={{ padding: 24, alignItems: 'center' }}>
            <Text style={{ fontSize: 14, color: token('subdued') }}>当前工作区暂无未提交变更</Text>
          </View>
        </If>

        <Each of={props.lines()} key={(l) => l.id}>
          {(line) => (
            <View>
              <If when={line().kind === 'header'}>
                <View
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 7,
                    backgroundColor: token('card'),
                    borderBottomWidth: 1,
                    borderBottomColor: token('border'),
                  }}
                >
                  <Text
                    style={{ fontSize: 12.5, fontWeight: '600', color: token('muted-foreground') }}
                  >
                    {line().text}
                  </Text>
                </View>
              </If>

              <If when={line().kind !== 'header'}>
                <View
                  role="button"
                  accessibilityLabel={'Quote diff line ' + line().num}
                  onPress={() => props.onQuoteLine(line())}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 7,
                    backgroundColor:
                      line().kind === 'add'
                        ? token('diff-add')
                        : line().kind === 'del'
                          ? token('diff-delete')
                          : 'transparent',
                    flexDirection: 'row',
                    gap: 10,
                  }}
                >
                  <Text style={{ width: 34, fontSize: 12, color: token('subdued') }}>
                    {line().num}
                  </Text>
                  <Text
                    style={{
                      flex: 1,
                      fontSize: 12.5,
                      lineHeight: 18,
                      color:
                        line().kind === 'add'
                          ? token('diff-add-foreground')
                          : line().kind === 'del'
                            ? token('diff-delete-foreground')
                            : token('foreground'),
                    }}
                  >
                    {line().text}
                  </Text>
                </View>
              </If>
            </View>
          )}
        </Each>
      </Scroll>
    </View>
  );
}

export function AutomationsOverlay(props: {
  schedules: () => AgentScheduledSummary[];
  loading: () => boolean;
  onRefresh: () => void;
  onBack: () => void;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: token('background') }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: token('border'),
        }}
      >
        <View
          role="button"
          accessibilityLabel="Back from automations"
          onPress={props.onBack}
          style={{ minWidth: 44, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: token('foreground') }}>
            {copy('‹ Back', '‹ 返回', '‹ 返回')}
          </Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: token('foreground') }}>
          定时任务
        </Text>
        <View
          role="button"
          accessibilityLabel="Refresh automations"
          onPress={props.onRefresh}
          style={{ minWidth: 44, minHeight: 40, justifyContent: 'center', alignItems: 'flex-end' }}
        >
          <Text style={{ fontSize: 13.5, color: token('muted-foreground') }}>刷新</Text>
        </View>
      </View>

      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 12 }}>
        <If when={props.loading()}>
          <Text style={{ fontSize: 13.5, color: token('muted-foreground') }}>
            正在读取远端 Host 定时任务…
          </Text>
        </If>

        <If when={!props.loading() && props.schedules().length === 0}>
          <View
            style={{
              borderRadius: 18,
              backgroundColor: token('card'),
              borderWidth: 1,
              borderColor: token('border'),
              padding: 18,
              gap: 6,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '600', color: token('foreground') }}>
              暂无自动化任务
            </Text>
            <Text style={{ fontSize: 13, color: token('muted-foreground') }}>
              在对话中让 Maka 创建定时巡检或日报任务后，会同步展示在这里。
            </Text>
          </View>
        </If>

        <Each of={props.schedules()} key={(s) => s.id}>
          {(task) => (
            <View
              style={{
                borderRadius: 18,
                backgroundColor: token('card'),
                borderWidth: 1,
                borderColor: token('border'),
                padding: 15,
                gap: 6,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: token('foreground') }}>
                  {task().title}
                </Text>
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: '600',
                    color: task().status === 'active' ? token('success') : token('subdued'),
                  }}
                >
                  {scheduleStatusLabel(task().status)}
                </Text>
              </View>
              <Text style={{ fontSize: 12.5, color: token('muted-foreground') }}>
                {(task().approved ? '已批准' : '待审批') +
                  (task().script ? ' · 脚本任务' : ' · 会话任务') +
                  (task().nextFireAt ? ' · 已排程' : '')}
              </Text>
              <If when={!!task().lastError}>
                <Text style={{ fontSize: 12, color: token('destructive') }}>
                  {'上次异常: ' + (task().lastError ?? '')}
                </Text>
              </If>
            </View>
          )}
        </Each>
      </Scroll>
    </View>
  );
}

export function SettingsOverlay(props: {
  hostState: () => HostStateSnapshot;
  defaultDelivery: () => 'steer' | 'queue';
  onToggleDelivery: () => void;
  onConnectHost: (host: SavedHostItem) => void;
  onRelayAuthorization: (host: SavedHostItem) => void;
  onDisconnect: () => void;
  onRemoveHost: (rootId: string) => void;
  onOpenPairing: () => void;
  onBack: () => void;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: token('background') }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: token('border'),
        }}
      >
        <View
          role="button"
          accessibilityLabel="Back from settings"
          onPress={props.onBack}
          style={{ minWidth: 44, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: token('foreground') }}>
            {copy('‹ Back', '‹ 返回', '‹ 返回')}
          </Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: token('foreground') }}>
          {copy('Settings', '设置', '設定')}
        </Text>
        <View style={{ minWidth: 44 }} />
      </View>

      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 18, paddingBottom: 40 }}>
        <View style={{ gap: 7 }}>
          <Text
            style={{ fontSize: 12, fontWeight: '600', color: token('subdued'), paddingLeft: 6 }}
          >
            外观与交互
          </Text>
          <View
            style={{
              borderRadius: 18,
              backgroundColor: token('card'),
              borderWidth: 1,
              borderColor: token('border'),
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                minHeight: 50,
                paddingHorizontal: 15,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text style={{ fontSize: 15, color: token('foreground') }}>
                {copy('Steer while the agent is running', '运行中发送直接纠偏', '執行中直接導正')}
              </Text>
              <Switch
                accessibilityLabel="Steer while running"
                checked={props.defaultDelivery() === 'steer'}
                onChange={props.onToggleDelivery}
              />
            </View>
          </View>
        </View>

        <View style={{ gap: 7 }}>
          <Text
            style={{ fontSize: 12, fontWeight: '600', color: token('subdued'), paddingLeft: 6 }}
          >
            已配对电脑
          </Text>
          <View
            style={{
              borderRadius: 18,
              backgroundColor: token('card'),
              borderWidth: 1,
              borderColor: token('border'),
              overflow: 'hidden',
            }}
          >
            <If when={props.hostState().hosts.length === 0}>
              <View style={{ padding: 16 }}>
                <Text style={{ fontSize: 14, color: token('subdued') }}>
                  {copy('No paired Hosts', '尚未配对任何远端 Host', '尚未配對任何遠端 Host')}
                </Text>
              </View>
            </If>

            <Each of={props.hostState().hosts} key={(h) => h.rootId}>
              {(item) => (
                <View
                  style={{
                    padding: 15,
                    borderBottomWidth: 1,
                    borderBottomColor: token('border'),
                    gap: 10,
                  }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <View style={{ gap: 2 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600', color: token('foreground') }}>
                        {item().hostName}
                      </Text>
                      <Text style={{ fontSize: 12, color: token('subdued') }}>
                        {'Root ' + item().rootId.slice(0, 12)}
                      </Text>
                    </View>
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: '600',
                        color: item().connected ? token('success') : token('subdued'),
                      }}
                    >
                      {item().connected
                        ? copy('Connected', '当前连接', '目前連線')
                        : copy('Offline', '离线', '離線')}
                    </Text>
                  </View>

                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <If when={item().connected}>
                      <View
                        role="button"
                        accessibilityLabel="Disconnect active host"
                        onPress={props.onDisconnect}
                        style={{
                          flex: 1,
                          minHeight: 38,
                          borderRadius: 19,
                          backgroundColor: token('muted'),
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text
                          style={{ fontSize: 13.5, fontWeight: '600', color: token('foreground') }}
                        >
                          断开连接
                        </Text>
                      </View>
                    </If>

                    <If when={!item().connected}>
                      <View
                        role="button"
                        accessibilityLabel={'Connect ' + item().hostName}
                        onPress={() => props.onConnectHost(item())}
                        style={{
                          flex: 1,
                          minHeight: 38,
                          borderRadius: 19,
                          backgroundColor: token('primary'),
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 13.5,
                            fontWeight: '600',
                            color: token('primary-foreground'),
                          }}
                        >
                          {copy('Connect', '连接', '連接')}
                        </Text>
                      </View>
                    </If>

                    <If when={!!item().relayUrls?.length}>
                      <View
                        role="button"
                        accessibilityLabel={'Relay Bearer ' + item().hostName}
                        class="min-h-11 justify-center px-3"
                        onPress={() => props.onRelayAuthorization(item())}
                      >
                        <Text class="text-foreground">Relay Bearer</Text>
                      </View>
                    </If>
                    <View
                      role="button"
                      accessibilityLabel={'Remove ' + item().hostName}
                      onPress={() => props.onRemoveHost(item().rootId)}
                      style={{
                        minWidth: 74,
                        minHeight: 38,
                        borderRadius: 19,
                        backgroundColor: token('destructive-soft'),
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingHorizontal: 14,
                      }}
                    >
                      <Text
                        style={{ fontSize: 13.5, fontWeight: '600', color: token('destructive') }}
                      >
                        {copy('Remove', '移除', '移除')}
                      </Text>
                    </View>
                  </View>
                </View>
              )}
            </Each>

            <View
              role="button"
              accessibilityLabel="Pair from settings"
              onPress={props.onOpenPairing}
              style={{
                minHeight: 48,
                paddingHorizontal: 15,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '500', color: token('foreground') }}>
                配对新电脑
              </Text>
              <Text style={{ fontSize: 15, color: token('subdued') }}>＋</Text>
            </View>
          </View>
        </View>

        <View style={{ gap: 7 }}>
          <Text
            style={{ fontSize: 12, fontWeight: '600', color: token('subdued'), paddingLeft: 6 }}
          >
            本机身份
          </Text>
          <View
            style={{
              borderRadius: 18,
              backgroundColor: token('card'),
              borderWidth: 1,
              borderColor: token('border'),
              padding: 15,
              gap: 4,
            }}
          >
            <Text style={{ fontSize: 13, color: token('muted-foreground') }}>Device Peer ID</Text>
            <Text style={{ fontSize: 12, color: token('subdued') }}>
              {props.hostState().devicePeerId || '初始化中…'}
            </Text>
          </View>
        </View>
      </Scroll>
    </View>
  );
}

export function NewRoomOverlay(props: {
  projects: () => AgentProject[];
  roots: () => { name: string; path: string }[];
  defaultWorkspace: () => { selection: AgentWorkspaceSelection; label: string } | null;
  busy: () => boolean;
  onCreateRoom: (title: string, workspace: AgentWorkspaceSelection) => void;
  onBack: () => void;
}) {
  const title = signal('');
  const initialWs = (): AgentWorkspaceSelection => {
    const def = props.defaultWorkspace();
    if (def) return def.selection;
    const firstProj = props.projects().find((p) => !p.archived && p.path);
    if (firstProj && firstProj.path) {
      return { kind: 'project', projectId: firstProj.reference.id, path: firstProj.path };
    }
    return { kind: 'directory', path: props.roots()[0]?.path ?? '~' };
  };
  const selected = signal<AgentWorkspaceSelection>(initialWs());

  const selectedKey = () => {
    const s = selected();
    if (s.kind === 'project') return 'proj:' + s.projectId;
    if (s.kind === 'directory' || s.kind === 'isolated_git') return 'dir:' + s.path;
    return 'sess:' + s.sessionId;
  };

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: token('background') }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: token('border'),
        }}
      >
        <View
          role="button"
          accessibilityLabel="Cancel new room"
          onPress={props.onBack}
          style={{ minWidth: 44, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: token('foreground') }}>
            {copy('‹ Cancel', '‹ 取消', '‹ 取消')}
          </Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: token('foreground') }}>
          新建协作 Room
        </Text>
        <View style={{ minWidth: 44 }} />
      </View>

      <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: 18, gap: 16 }}>
        <View
          style={{
            borderRadius: 18,
            backgroundColor: token('card'),
            borderWidth: 1,
            borderColor: token('border'),
            padding: 16,
            gap: 10,
          }}
        >
          <Text style={{ fontSize: 13.5, fontWeight: '600', color: token('muted-foreground') }}>
            Room 名称
          </Text>
          <Input
            accessibilityLabel="New room title input"
            value={title()}
            onChange={({ value }: { value: string }) => title.set(value)}
            placeholder="例如：发布前联调 Room"
            style={{
              minHeight: 42,
              borderRadius: 11,
              backgroundColor: token('muted'),
              paddingHorizontal: 12,
              color: token('foreground'),
              fontSize: 14.5,
            }}
          />

          <Text
            style={{
              fontSize: 13.5,
              fontWeight: '600',
              color: token('muted-foreground'),
              marginTop: 6,
            }}
          >
            所属工作区
          </Text>

          <If when={props.projects().filter((p) => !p.archived && !!p.path).length > 0}>
            <View style={{ gap: 6 }}>
              <Each
                of={props.projects().filter((p) => !p.archived && !!p.path)}
                key={(p) => p.reference.id}
              >
                {(proj) => (
                  <View
                    role="button"
                    accessibilityLabel={'Room workspace ' + proj().name}
                    onPress={() => {
                      if (proj().path) {
                        selected.set({
                          kind: 'project',
                          projectId: proj().reference.id,
                          path: proj().path!,
                        });
                      }
                    }}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 11,
                      backgroundColor:
                        selectedKey() === 'proj:' + proj().reference.id
                          ? token('selected')
                          : token('muted'),
                    }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '500', color: token('foreground') }}>
                      {proj().name}
                    </Text>
                    <Text style={{ fontSize: 11.5, color: token('subdued') }}>
                      {proj().path ?? ''}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          </If>

          <If when={props.roots().length > 0}>
            <View style={{ gap: 6 }}>
              <Each of={props.roots()} key={(r) => r.path}>
                {(root) => (
                  <View
                    role="button"
                    accessibilityLabel={'Room root ' + root().name}
                    onPress={() => selected.set({ kind: 'directory', path: root().path })}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 11,
                      backgroundColor:
                        selectedKey() === 'dir:' + root().path ? token('selected') : token('muted'),
                    }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '500', color: token('foreground') }}>
                      {root().name}
                    </Text>
                    <Text style={{ fontSize: 11.5, color: token('subdued') }}>{root().path}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>

        <View
          role="button"
          accessibilityLabel="Create room submit"
          onPress={() => {
            const cleanTitle = title().trim();
            if (cleanTitle.length > 0 && !props.busy()) {
              props.onCreateRoom(cleanTitle, selected());
            }
          }}
          style={{
            minHeight: 46,
            borderRadius: 23,
            backgroundColor:
              title().trim().length > 0 && !props.busy() ? token('primary') : token('muted'),
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text
            style={{
              fontSize: 15.5,
              fontWeight: '600',
              color:
                title().trim().length > 0 && !props.busy()
                  ? token('primary-foreground')
                  : token('subdued'),
            }}
          >
            {props.busy() ? '正在创建…' : '创建 Room'}
          </Text>
        </View>
      </Scroll>
    </View>
  );
}

export function WorkspacePickerOverlay(props: {
  projects: () => AgentProject[];
  roots: () => { name: string; path: string }[];
  onSelect: (selection: AgentWorkspaceSelection, label: string) => void;
  onBack: () => void;
}) {
  const browsingPath = signal<string | null>(null);
  const children = signal<{ name: string; path: string }[]>([]);
  const dirAfter = signal<string | null>(null);
  const loadingDir = signal(false);
  const loadingMoreDir = signal(false);
  const dirError = signal<string | null>(null);
  let dirBrowseGen = 0;

  const openDirectory = (path: string) => {
    dirBrowseGen += 1;
    const gen = dirBrowseGen;
    browsingPath.set(path);
    children.set([]);
    dirAfter.set(null);
    loadingDir.set(true);
    loadingMoreDir.set(false);
    dirError.set(null);
    agentListDirectoryChildren(path, null).then(
      (res) => {
        if (gen !== dirBrowseGen || browsingPath() !== path) return;
        children.set(res.children);
        dirAfter.set(res.after);
        loadingDir.set(false);
      },
      (err: Error) => {
        if (gen !== dirBrowseGen || browsingPath() !== path) return;
        children.set([]);
        dirAfter.set(null);
        loadingDir.set(false);
        dirError.set(err.message);
      },
    );
  };

  const loadMoreDirectories = () => {
    const path = browsingPath();
    const after = dirAfter();
    if (!path || !after || loadingDir() || loadingMoreDir()) return;
    const gen = dirBrowseGen;
    loadingMoreDir.set(true);
    agentListDirectoryChildren(path, after).then(
      (res) => {
        if (gen !== dirBrowseGen || browsingPath() !== path) return;
        const seen = new Set(children().map((c) => c.path));
        children.set([...children(), ...res.children.filter((c) => !seen.has(c.path))]);
        dirAfter.set(res.after);
        loadingMoreDir.set(false);
      },
      (err: Error) => {
        if (gen !== dirBrowseGen || browsingPath() !== path) return;
        loadingMoreDir.set(false);
        dirError.set(err.message);
      },
    );
  };

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: token('background') }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: token('border'),
        }}
      >
        <View
          role="button"
          accessibilityLabel="Back from workspace picker"
          onPress={() => {
            if (browsingPath() !== null) {
              dirBrowseGen += 1;
              browsingPath.set(null);
              children.set([]);
              dirAfter.set(null);
              loadingDir.set(false);
              loadingMoreDir.set(false);
              dirError.set(null);
            } else {
              props.onBack();
            }
          }}
          style={{ minWidth: 52, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: token('foreground') }}>
            {browsingPath() !== null ? '‹ 根目录' : copy('‹ Back', '‹ 返回', '‹ 返回')}
          </Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: token('foreground') }}>
          选择工作区
        </Text>
        <View style={{ minWidth: 52 }} />
      </View>

      <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: 16, gap: 14 }}>
        <If when={browsingPath() !== null}>
          <View style={{ gap: 10 }}>
            <View
              role="button"
              accessibilityLabel="Use current directory"
              onPress={() => {
                const p = browsingPath()!;
                const name = p.split('/').filter(Boolean).pop() ?? p;
                props.onSelect({ kind: 'directory', path: p }, name);
              }}
              style={{
                minHeight: 44,
                borderRadius: 14,
                backgroundColor: token('primary'),
                paddingHorizontal: 14,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                style={{ fontSize: 14.5, fontWeight: '600', color: token('primary-foreground') }}
              >
                {'使用当前目录 · ' + (browsingPath()?.split('/').filter(Boolean).pop() ?? '')}
              </Text>
            </View>

            <If when={dirError() !== null}>
              <Text style={{ fontSize: 12.5, color: token('destructive') }}>{dirError()}</Text>
            </If>
            <If when={loadingDir()}>
              <Text style={{ fontSize: 13, color: token('subdued') }}>正在读取子目录…</Text>
            </If>

            <Each of={children()} key={(d) => d.path}>
              {(dir) => (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    borderRadius: 12,
                    backgroundColor: token('card'),
                    borderWidth: 1,
                    borderColor: token('border'),
                  }}
                >
                  <View
                    role="button"
                    accessibilityLabel={'Select dir ' + dir().name}
                    onPress={() =>
                      props.onSelect({ kind: 'directory', path: dir().path }, dir().name)
                    }
                    style={{ flex: 1, gap: 2 }}
                  >
                    <Text style={{ fontSize: 14.5, fontWeight: '500', color: token('foreground') }}>
                      {dir().name}
                    </Text>
                    <Text style={{ fontSize: 11.5, color: token('subdued') }}>{dir().path}</Text>
                  </View>
                  <View
                    role="button"
                    accessibilityLabel={'Browse dir ' + dir().name}
                    onPress={() => openDirectory(dir().path)}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 8,
                      backgroundColor: token('muted'),
                    }}
                  >
                    <Text style={{ fontSize: 12, color: token('muted-foreground') }}>进入 ›</Text>
                  </View>
                </View>
              )}
            </Each>

            <If when={dirAfter() !== null}>
              <View
                role="button"
                accessibilityLabel="Load more directories"
                onPress={loadMoreDirectories}
                style={{
                  minHeight: 40,
                  borderRadius: 12,
                  backgroundColor: token('muted'),
                  borderWidth: 1,
                  borderColor: token('border'),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: '600', color: token('muted-foreground') }}>
                  {loadingMoreDir() ? '正在加载更多目录…' : '加载更多目录'}
                </Text>
              </View>
            </If>
          </View>
        </If>

        <If when={browsingPath() === null}>
          <View style={{ gap: 14 }}>
            <If when={props.projects().filter((p) => !p.archived && !!p.path).length > 0}>
              <View style={{ gap: 6 }}>
                <Text style={{ fontSize: 12.5, fontWeight: '600', color: token('subdued') }}>
                  已有项目
                </Text>
                <Each
                  of={props.projects().filter((p) => !p.archived && !!p.path)}
                  key={(p) => p.reference.id}
                >
                  {(proj) => (
                    <View
                      role="button"
                      accessibilityLabel={'Pick project ' + proj().name}
                      onPress={() => {
                        if (proj().path) {
                          props.onSelect(
                            {
                              kind: 'project',
                              projectId: proj().reference.id,
                              path: proj().path!,
                            },
                            proj().name,
                          );
                        }
                      }}
                      style={{
                        paddingHorizontal: 14,
                        paddingVertical: 11,
                        borderRadius: 13,
                        backgroundColor: token('card'),
                        borderWidth: 1,
                        borderColor: token('border'),
                        gap: 2,
                      }}
                    >
                      <Text
                        style={{ fontSize: 14.5, fontWeight: '600', color: token('foreground') }}
                      >
                        {proj().name}
                      </Text>
                      <Text style={{ fontSize: 11.5, color: token('subdued') }}>
                        {proj().path ?? ''}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>

            <If when={props.roots().length > 0}>
              <View style={{ gap: 6 }}>
                <Text style={{ fontSize: 12.5, fontWeight: '600', color: token('subdued') }}>
                  远端目录
                </Text>
                <Each of={props.roots()} key={(r) => r.path}>
                  {(root) => (
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        paddingHorizontal: 14,
                        paddingVertical: 11,
                        borderRadius: 13,
                        backgroundColor: token('card'),
                        borderWidth: 1,
                        borderColor: token('border'),
                      }}
                    >
                      <View
                        role="button"
                        accessibilityLabel={'Pick root ' + root().name}
                        onPress={() =>
                          props.onSelect({ kind: 'directory', path: root().path }, root().name)
                        }
                        style={{ flex: 1, gap: 2 }}
                      >
                        <Text
                          style={{ fontSize: 14.5, fontWeight: '500', color: token('foreground') }}
                        >
                          {root().name}
                        </Text>
                        <Text style={{ fontSize: 11.5, color: token('subdued') }}>
                          {root().path}
                        </Text>
                      </View>
                      <View
                        role="button"
                        accessibilityLabel={'Browse root ' + root().name}
                        onPress={() => openDirectory(root().path)}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRadius: 8,
                          backgroundColor: token('muted'),
                        }}
                      >
                        <Text style={{ fontSize: 12, color: token('muted-foreground') }}>
                          子目录 ›
                        </Text>
                      </View>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </View>
        </If>
      </Scroll>
    </View>
  );
}

export function ModelPickerOverlay(props: {
  choices: () => AgentModelChoice[];
  loading: () => boolean;
  currentBackend: () => AgentBackendPreference | null;
  onSearch: (query: string) => void;
  onSelect: (backend: AgentBackendPreference) => void;
  onBack: () => void;
}) {
  const query = signal('');
  const pendingChoice = signal<AgentModelChoice | null>(null);

  const isSelectedChoice = (choice: AgentModelChoice): boolean => {
    const cur = props.currentBackend();
    if (!cur) return false;
    if (cur.kind === 'model' && choice.selection.kind === 'model') {
      return (
        cur.connectionId === choice.selection.connectionId &&
        cur.modelId === choice.selection.modelId
      );
    }
    if (cur.kind === 'executor' && choice.selection.kind === 'executor') {
      return cur.selection.executor === choice.selection.executor;
    }
    return false;
  };

  const applyChoiceWithThinking = (choice: AgentModelChoice, level: string | null) => {
    if (choice.selection.kind === 'model') {
      props.onSelect({
        ...choice.selection,
        thinkingLevel: level,
      });
    } else {
      props.onSelect(choice.selection);
    }
  };

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: token('background') }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: token('border'),
        }}
      >
        <View
          role="button"
          accessibilityLabel="Back from model picker"
          onPress={props.onBack}
          style={{ minWidth: 52, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: token('foreground') }}>
            {copy('‹ Back', '‹ 返回', '‹ 返回')}
          </Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: token('foreground') }}>
          模型与思考强度
        </Text>
        <View style={{ minWidth: 52 }} />
      </View>

      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}>
        <Input
          accessibilityLabel="Search models input"
          value={query()}
          onChange={({ value }: { value: string }) => {
            query.set(value);
            props.onSearch(value);
          }}
          placeholder="搜索模型名称或来源…"
          style={{
            minHeight: 38,
            borderRadius: 11,
            backgroundColor: token('muted'),
            paddingHorizontal: 12,
            color: token('foreground'),
            fontSize: 14,
          }}
        />
      </View>

      <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: 16, gap: 10 }}>
        <If when={props.loading()}>
          <Text style={{ fontSize: 13, color: token('subdued') }}>正在加载模型目录…</Text>
        </If>

        <If when={!props.loading() && props.choices().length === 0}>
          <View
            style={{
              padding: 18,
              borderRadius: 16,
              backgroundColor: token('card'),
              borderWidth: 1,
              borderColor: token('border'),
              gap: 4,
            }}
          >
            <Text style={{ fontSize: 14.5, fontWeight: '600', color: token('foreground') }}>
              暂无可用模型
            </Text>
            <Text style={{ fontSize: 12.5, color: token('muted-foreground') }}>
              请在远端 Host 配置模型连接后重试。
            </Text>
          </View>
        </If>

        <Each
          of={props.choices()}
          key={(c) =>
            c.selection.kind === 'model'
              ? c.selection.connectionId + ':' + c.selection.modelId
              : 'exec:' + c.selection.selection.executor + ':' + c.label
          }
        >
          {(choice) => {
            const expanded = () =>
              pendingChoice()?.label === choice().label &&
              pendingChoice()?.sourceName === choice().sourceName;
            const currentThinking = () => {
              const cur = props.currentBackend();
              return cur && cur.kind === 'model' ? (cur.thinkingLevel ?? null) : null;
            };

            return (
              <View
                style={{
                  borderRadius: 14,
                  backgroundColor: isSelectedChoice(choice()) ? token('selected') : token('card'),
                  borderWidth: 1,
                  borderColor: token('border'),
                  padding: 12,
                  gap: 8,
                }}
              >
                <View
                  role="button"
                  accessibilityLabel={'Model ' + choice().label}
                  onPress={() => {
                    if (choice().selection.kind === 'model' && choice().thinkingLevels.length > 0) {
                      pendingChoice.set(expanded() ? null : choice());
                    } else {
                      applyChoiceWithThinking(choice(), null);
                    }
                  }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: 14.5, fontWeight: '600', color: token('foreground') }}>
                      {choice().label}
                    </Text>
                    <Text style={{ fontSize: 12, color: token('subdued') }}>
                      {choice().sourceName +
                        (choice().thinkingLevels.length > 0 ? ' · 支持思考强度' : '')}
                    </Text>
                  </View>
                  <If when={isSelectedChoice(choice())}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: token('foreground') }}>
                      ✓
                    </Text>
                  </If>
                </View>

                <If
                  when={
                    choice().selection.kind === 'model' &&
                    choice().thinkingLevels.length > 0 &&
                    (expanded() || isSelectedChoice(choice()))
                  }
                >
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 2 }}>
                    <View
                      role="button"
                      accessibilityLabel={'Thinking default ' + choice().label}
                      onPress={() => applyChoiceWithThinking(choice(), null)}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: 9,
                        backgroundColor:
                          isSelectedChoice(choice()) && currentThinking() === null
                            ? token('primary')
                            : token('muted'),
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: '600',
                          color:
                            isSelectedChoice(choice()) && currentThinking() === null
                              ? token('primary-foreground')
                              : token('muted-foreground'),
                        }}
                      >
                        默认
                      </Text>
                    </View>
                    <Each of={choice().thinkingLevels} key={(lvl) => lvl}>
                      {(lvl) => (
                        <View
                          role="button"
                          accessibilityLabel={'Thinking ' + lvl() + ' ' + choice().label}
                          onPress={() => applyChoiceWithThinking(choice(), lvl())}
                          style={{
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 9,
                            backgroundColor:
                              isSelectedChoice(choice()) && currentThinking() === lvl()
                                ? token('primary')
                                : token('muted'),
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 12,
                              fontWeight: '600',
                              color:
                                isSelectedChoice(choice()) && currentThinking() === lvl()
                                  ? token('primary-foreground')
                                  : token('muted-foreground'),
                            }}
                          >
                            {lvl()}
                          </Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
              </View>
            );
          }}
        </Each>
      </Scroll>
    </View>
  );
}
