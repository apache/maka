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

import { Scroll, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import {
  agentListDirectoryChildren,
  formatSas,
  type AgentBackendPreference,
  type AgentModelChoice,
  type AgentProject,
  type AgentScheduledSummary,
  type AgentWorkspaceSelection,
  type HostStateSnapshot,
  type ParsedTicketInfo,
  type SavedHostItem,
} from './bridge';
import { palette, themeMode, toggleThemeMode } from './theme';

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
    <View style={{ flex: 1, backgroundColor: palette().bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: palette().line,
        }}
      >
        <View
          role="button"
          accessibilityLabel="Back from diff"
          onPress={props.onBack}
          style={{ minWidth: 44, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: palette().ink }}>‹ 返回</Text>
        </View>
        <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>
          {props.title()}
        </Text>
        <View style={{ minWidth: 44 }} />
      </View>

      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 9,
          borderBottomWidth: 1,
          borderBottomColor: palette().line,
          gap: 4,
        }}
      >
        <Text style={{ fontSize: 12.5, color: palette().ink2 }}>轻点任意一行可引用发给 Maka</Text>
        <If when={props.truncatedNotice() !== null}>
          <Text style={{ fontSize: 12, color: palette().waiting }}>
            {props.truncatedNotice() ?? ''}
          </Text>
        </If>
      </View>

      <Scroll style={{ flex: 1 }} contentStyle={{ paddingVertical: 8, paddingBottom: 32 }}>
        <If when={props.lines().length === 0}>
          <View style={{ padding: 24, alignItems: 'center' }}>
            <Text style={{ fontSize: 14, color: palette().ink3 }}>当前工作区暂无未提交变更</Text>
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
                    backgroundColor: palette().surface,
                    borderBottomWidth: 1,
                    borderBottomColor: palette().line,
                  }}
                >
                  <Text style={{ fontSize: 12.5, fontWeight: '600', color: palette().ink2 }}>
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
                        ? palette().diffAddBg
                        : line().kind === 'del'
                          ? palette().diffDelBg
                          : 'transparent',
                    flexDirection: 'row',
                    gap: 10,
                  }}
                >
                  <Text style={{ width: 34, fontSize: 12, color: palette().ink3 }}>
                    {line().num}
                  </Text>
                  <Text
                    style={{
                      flex: 1,
                      fontSize: 12.5,
                      lineHeight: 18,
                      color:
                        line().kind === 'add'
                          ? palette().diffAddInk
                          : line().kind === 'del'
                            ? palette().diffDelInk
                            : palette().ink,
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

export function PairingOverlay(props: {
  ticketUri: () => string;
  onChangeUri: (uri: string) => void;
  parsedTicket: () => ParsedTicketInfo | null;
  pairingError: () => string | null;
  busy: () => boolean;
  onParse: () => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const showTech = signal(false);

  return (
    <View style={{ flex: 1, backgroundColor: palette().bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: palette().line,
        }}
      >
        <View
          role="button"
          accessibilityLabel="Back from pairing"
          onPress={props.onBack}
          style={{ minWidth: 44, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: palette().ink }}>‹ 取消</Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>配对远端电脑</Text>
        <View style={{ minWidth: 44 }} />
      </View>

      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 18, gap: 16 }}>
        <View
          style={{
            borderRadius: 20,
            backgroundColor: palette().surface,
            borderWidth: 1,
            borderColor: palette().line,
            padding: 16,
            gap: 10,
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: '600', color: palette().ink }}>
            扫码或粘贴配对链接
          </Text>
          <Input
            accessibilityLabel="Pairing URI input"
            value={props.ticketUri()}
            onChange={({ value }: { value: string }) => props.onChangeUri(value)}
            placeholder="maka://pair/v1?..."
            style={{
              minHeight: 44,
              borderRadius: 12,
              backgroundColor: palette().surface2,
              paddingHorizontal: 12,
              color: palette().ink,
              fontSize: 13.5,
            }}
          />
          <View
            role="button"
            accessibilityLabel="Decode pairing ticket"
            onPress={props.onParse}
            style={{
              minHeight: 42,
              borderRadius: 21,
              backgroundColor: palette().surface2,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', color: palette().ink }}>
              解析配对码并生成 6 位核对数字
            </Text>
          </View>
        </View>

        <If when={props.pairingError() !== null}>
          <View
            style={{
              padding: 13,
              borderRadius: 14,
              backgroundColor: palette().dangerSoft,
            }}
          >
            <Text style={{ fontSize: 13, color: palette().danger }}>{props.pairingError()}</Text>
          </View>
        </If>

        <If when={props.parsedTicket() !== null}>
          <View
            style={{
              borderRadius: 22,
              backgroundColor: palette().surface,
              borderWidth: 1,
              borderColor: palette().line,
              padding: 20,
              gap: 14,
              alignItems: 'center',
            }}
          >
            <Text style={{ fontSize: 14, color: palette().ink2 }}>
              {'核对桌面端 ' + (props.parsedTicket()?.hostName ?? '') + ' 上的 6 位数字'}
            </Text>

            <Text
              style={{
                fontSize: 38,
                fontWeight: '700',
                letterSpacing: 6,
                color: palette().ink,
              }}
            >
              {formatSas(props.parsedTicket()?.sasCode ?? '')}
            </Text>

            <View
              role="button"
              accessibilityLabel="Confirm pairing and connect"
              onPress={() => {
                if (!props.busy()) props.onConfirm();
              }}
              style={{
                width: '100%',
                minHeight: 46,
                borderRadius: 23,
                backgroundColor: palette().primaryBg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 15.5, fontWeight: '600', color: palette().primaryText }}>
                {props.busy() ? '正在安全配对…' : '数字一致，确认连接'}
              </Text>
            </View>

            <View
              role="button"
              accessibilityLabel="Toggle pairing technical details"
              onPress={() => showTech.set(!showTech())}
              style={{ paddingVertical: 4 }}
            >
              <Text style={{ fontSize: 12.5, color: palette().ink3 }}>
                {showTech() ? '▾ 收起技术细节' : '▸ 查看技术细节'}
              </Text>
            </View>

            <If when={showTech()}>
              <View
                style={{
                  width: '100%',
                  borderRadius: 12,
                  backgroundColor: palette().surface2,
                  padding: 12,
                  gap: 4,
                }}
              >
                <Text style={{ fontSize: 11.5, color: palette().ink2 }}>
                  {'Root ID: ' + (props.parsedTicket()?.rootId ?? '')}
                </Text>
                <Text style={{ fontSize: 11.5, color: palette().ink2 }}>
                  {'Peer ID: ' + (props.parsedTicket()?.peerId ?? '')}
                </Text>
                <Text style={{ fontSize: 11.5, color: palette().ink2 }}>
                  {'Endpoint: ' + (props.parsedTicket()?.endpoints.join(', ') ?? '')}
                </Text>
              </View>
            </If>
          </View>
        </If>
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
    <View style={{ flex: 1, backgroundColor: palette().bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: palette().line,
        }}
      >
        <View
          role="button"
          accessibilityLabel="Back from automations"
          onPress={props.onBack}
          style={{ minWidth: 44, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: palette().ink }}>‹ 返回</Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>定时任务</Text>
        <View
          role="button"
          accessibilityLabel="Refresh automations"
          onPress={props.onRefresh}
          style={{ minWidth: 44, minHeight: 40, justifyContent: 'center', alignItems: 'flex-end' }}
        >
          <Text style={{ fontSize: 13.5, color: palette().ink2 }}>刷新</Text>
        </View>
      </View>

      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 12 }}>
        <If when={props.loading()}>
          <Text style={{ fontSize: 13.5, color: palette().ink2 }}>正在读取远端 Host 定时任务…</Text>
        </If>

        <If when={!props.loading() && props.schedules().length === 0}>
          <View
            style={{
              borderRadius: 18,
              backgroundColor: palette().surface,
              borderWidth: 1,
              borderColor: palette().line,
              padding: 18,
              gap: 6,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>
              暂无自动化任务
            </Text>
            <Text style={{ fontSize: 13, color: palette().ink2 }}>
              在对话中让 Maka 创建定时巡检或日报任务后，会同步展示在这里。
            </Text>
          </View>
        </If>

        <Each of={props.schedules()} key={(s) => s.id}>
          {(task) => (
            <View
              style={{
                borderRadius: 18,
                backgroundColor: palette().surface,
                borderWidth: 1,
                borderColor: palette().line,
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
                <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>
                  {task().title}
                </Text>
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: '600',
                    color: task().status === 'active' ? palette().online : palette().ink3,
                  }}
                >
                  {scheduleStatusLabel(task().status)}
                </Text>
              </View>
              <Text style={{ fontSize: 12.5, color: palette().ink2 }}>
                {(task().approved ? '已批准' : '待审批') +
                  (task().script ? ' · 脚本任务' : ' · 会话任务') +
                  (task().nextFireAt ? ' · 已排程' : '')}
              </Text>
              <If when={!!task().lastError}>
                <Text style={{ fontSize: 12, color: palette().danger }}>
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
  onDisconnect: () => void;
  onRemoveHost: (rootId: string) => void;
  onOpenPairing: () => void;
  onBack: () => void;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: palette().bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: palette().line,
        }}
      >
        <View
          role="button"
          accessibilityLabel="Back from settings"
          onPress={props.onBack}
          style={{ minWidth: 44, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: palette().ink }}>‹ 返回</Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>设置</Text>
        <View style={{ minWidth: 44 }} />
      </View>

      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 18, paddingBottom: 40 }}>
        <View style={{ gap: 7 }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: palette().ink3, paddingLeft: 6 }}>
            外观与交互
          </Text>
          <View
            style={{
              borderRadius: 18,
              backgroundColor: palette().surface,
              borderWidth: 1,
              borderColor: palette().line,
              overflow: 'hidden',
            }}
          >
            <View
              role="button"
              accessibilityLabel="Toggle theme"
              onPress={toggleThemeMode}
              style={{
                minHeight: 50,
                paddingHorizontal: 15,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottomWidth: 1,
                borderBottomColor: palette().line,
              }}
            >
              <Text style={{ fontSize: 15, color: palette().ink }}>主题外观</Text>
              <Text style={{ fontSize: 14, color: palette().ink2 }}>
                {themeMode() === 'dark' ? '深石墨暗色' : '暖纸白亮色'}
              </Text>
            </View>

            <View
              role="button"
              accessibilityLabel="Toggle default send delivery"
              onPress={props.onToggleDelivery}
              style={{
                minHeight: 50,
                paddingHorizontal: 15,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text style={{ fontSize: 15, color: palette().ink }}>运行中默认发送行为</Text>
              <Text style={{ fontSize: 14, color: palette().ink2 }}>
                {props.defaultDelivery() === 'steer' ? 'Steer · 直接纠偏' : 'Queue · 排队发送'}
              </Text>
            </View>
          </View>
        </View>

        <View style={{ gap: 7 }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: palette().ink3, paddingLeft: 6 }}>
            已配对电脑
          </Text>
          <View
            style={{
              borderRadius: 18,
              backgroundColor: palette().surface,
              borderWidth: 1,
              borderColor: palette().line,
              overflow: 'hidden',
            }}
          >
            <If when={props.hostState().hosts.length === 0}>
              <View style={{ padding: 16 }}>
                <Text style={{ fontSize: 14, color: palette().ink3 }}>尚未配对任何远端 Host</Text>
              </View>
            </If>

            <Each of={props.hostState().hosts} key={(h) => h.rootId}>
              {(item) => (
                <View
                  style={{
                    padding: 15,
                    borderBottomWidth: 1,
                    borderBottomColor: palette().line,
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
                      <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>
                        {item().hostName}
                      </Text>
                      <Text style={{ fontSize: 12, color: palette().ink3 }}>
                        {'Root ' + item().rootId.slice(0, 12)}
                      </Text>
                    </View>
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: '600',
                        color: item().connected ? palette().online : palette().ink3,
                      }}
                    >
                      {item().connected ? '当前连接' : '离线'}
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
                          backgroundColor: palette().surface2,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text style={{ fontSize: 13.5, fontWeight: '600', color: palette().ink }}>
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
                          backgroundColor: palette().primaryBg,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 13.5,
                            fontWeight: '600',
                            color: palette().primaryText,
                          }}
                        >
                          连接
                        </Text>
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
                        backgroundColor: palette().dangerSoft,
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingHorizontal: 14,
                      }}
                    >
                      <Text style={{ fontSize: 13.5, fontWeight: '600', color: palette().danger }}>
                        移除
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
              <Text style={{ fontSize: 15, fontWeight: '500', color: palette().ink }}>
                配对新电脑
              </Text>
              <Text style={{ fontSize: 15, color: palette().ink3 }}>＋</Text>
            </View>
          </View>
        </View>

        <View style={{ gap: 7 }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: palette().ink3, paddingLeft: 6 }}>
            本机身份
          </Text>
          <View
            style={{
              borderRadius: 18,
              backgroundColor: palette().surface,
              borderWidth: 1,
              borderColor: palette().line,
              padding: 15,
              gap: 4,
            }}
          >
            <Text style={{ fontSize: 13, color: palette().ink2 }}>Device Peer ID</Text>
            <Text style={{ fontSize: 12, color: palette().ink3 }}>
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
    <View style={{ flex: 1, minHeight: 0, backgroundColor: palette().bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: palette().line,
        }}
      >
        <View
          role="button"
          accessibilityLabel="Cancel new room"
          onPress={props.onBack}
          style={{ minWidth: 44, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: palette().ink }}>‹ 取消</Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>新建协作 Room</Text>
        <View style={{ minWidth: 44 }} />
      </View>

      <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: 18, gap: 16 }}>
        <View
          style={{
            borderRadius: 18,
            backgroundColor: palette().surface,
            borderWidth: 1,
            borderColor: palette().line,
            padding: 16,
            gap: 10,
          }}
        >
          <Text style={{ fontSize: 13.5, fontWeight: '600', color: palette().ink2 }}>
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
              backgroundColor: palette().surface2,
              paddingHorizontal: 12,
              color: palette().ink,
              fontSize: 14.5,
            }}
          />

          <Text style={{ fontSize: 13.5, fontWeight: '600', color: palette().ink2, marginTop: 6 }}>
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
                          ? palette().rowActive
                          : palette().surface2,
                    }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '500', color: palette().ink }}>
                      {proj().name}
                    </Text>
                    <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
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
                        selectedKey() === 'dir:' + root().path
                          ? palette().rowActive
                          : palette().surface2,
                    }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '500', color: palette().ink }}>
                      {root().name}
                    </Text>
                    <Text style={{ fontSize: 11.5, color: palette().ink3 }}>{root().path}</Text>
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
              title().trim().length > 0 && !props.busy() ? palette().primaryBg : palette().surface2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text
            style={{
              fontSize: 15.5,
              fontWeight: '600',
              color:
                title().trim().length > 0 && !props.busy() ? palette().primaryText : palette().ink3,
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
    <View style={{ flex: 1, minHeight: 0, backgroundColor: palette().bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: palette().line,
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
          <Text style={{ fontSize: 16, color: palette().ink }}>
            {browsingPath() !== null ? '‹ 根目录' : '‹ 返回'}
          </Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>选择工作区</Text>
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
                backgroundColor: palette().primaryBg,
                paddingHorizontal: 14,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 14.5, fontWeight: '600', color: palette().primaryText }}>
                {'使用当前目录 · ' + (browsingPath()?.split('/').filter(Boolean).pop() ?? '')}
              </Text>
            </View>

            <If when={dirError() !== null}>
              <Text style={{ fontSize: 12.5, color: palette().danger }}>{dirError()}</Text>
            </If>
            <If when={loadingDir()}>
              <Text style={{ fontSize: 13, color: palette().ink3 }}>正在读取子目录…</Text>
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
                    backgroundColor: palette().surface,
                    borderWidth: 1,
                    borderColor: palette().line,
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
                    <Text style={{ fontSize: 14.5, fontWeight: '500', color: palette().ink }}>
                      {dir().name}
                    </Text>
                    <Text style={{ fontSize: 11.5, color: palette().ink3 }}>{dir().path}</Text>
                  </View>
                  <View
                    role="button"
                    accessibilityLabel={'Browse dir ' + dir().name}
                    onPress={() => openDirectory(dir().path)}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 8,
                      backgroundColor: palette().surface2,
                    }}
                  >
                    <Text style={{ fontSize: 12, color: palette().ink2 }}>进入 ›</Text>
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
                  backgroundColor: palette().surface2,
                  borderWidth: 1,
                  borderColor: palette().line,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: '600', color: palette().ink2 }}>
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
                <Text style={{ fontSize: 12.5, fontWeight: '600', color: palette().ink3 }}>
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
                        backgroundColor: palette().surface,
                        borderWidth: 1,
                        borderColor: palette().line,
                        gap: 2,
                      }}
                    >
                      <Text style={{ fontSize: 14.5, fontWeight: '600', color: palette().ink }}>
                        {proj().name}
                      </Text>
                      <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
                        {proj().path ?? ''}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>

            <If when={props.roots().length > 0}>
              <View style={{ gap: 6 }}>
                <Text style={{ fontSize: 12.5, fontWeight: '600', color: palette().ink3 }}>
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
                        backgroundColor: palette().surface,
                        borderWidth: 1,
                        borderColor: palette().line,
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
                        <Text style={{ fontSize: 14.5, fontWeight: '500', color: palette().ink }}>
                          {root().name}
                        </Text>
                        <Text style={{ fontSize: 11.5, color: palette().ink3 }}>{root().path}</Text>
                      </View>
                      <View
                        role="button"
                        accessibilityLabel={'Browse root ' + root().name}
                        onPress={() => openDirectory(root().path)}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRadius: 8,
                          backgroundColor: palette().surface2,
                        }}
                      >
                        <Text style={{ fontSize: 12, color: palette().ink2 }}>子目录 ›</Text>
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
    <View style={{ flex: 1, minHeight: 0, backgroundColor: palette().bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: palette().line,
        }}
      >
        <View
          role="button"
          accessibilityLabel="Back from model picker"
          onPress={props.onBack}
          style={{ minWidth: 52, minHeight: 40, justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 16, color: palette().ink }}>‹ 返回</Text>
        </View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>
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
            backgroundColor: palette().surface2,
            paddingHorizontal: 12,
            color: palette().ink,
            fontSize: 14,
          }}
        />
      </View>

      <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: 16, gap: 10 }}>
        <If when={props.loading()}>
          <Text style={{ fontSize: 13, color: palette().ink3 }}>正在加载模型目录…</Text>
        </If>

        <If when={!props.loading() && props.choices().length === 0}>
          <View
            style={{
              padding: 18,
              borderRadius: 16,
              backgroundColor: palette().surface,
              borderWidth: 1,
              borderColor: palette().line,
              gap: 4,
            }}
          >
            <Text style={{ fontSize: 14.5, fontWeight: '600', color: palette().ink }}>
              暂无可用模型
            </Text>
            <Text style={{ fontSize: 12.5, color: palette().ink2 }}>
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
                  backgroundColor: isSelectedChoice(choice())
                    ? palette().rowActive
                    : palette().surface,
                  borderWidth: 1,
                  borderColor: palette().line,
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
                    <Text style={{ fontSize: 14.5, fontWeight: '600', color: palette().ink }}>
                      {choice().label}
                    </Text>
                    <Text style={{ fontSize: 12, color: palette().ink3 }}>
                      {choice().sourceName +
                        (choice().thinkingLevels.length > 0 ? ' · 支持思考强度' : '')}
                    </Text>
                  </View>
                  <If when={isSelectedChoice(choice())}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: palette().ink }}>✓</Text>
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
                            ? palette().primaryBg
                            : palette().surface2,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: '600',
                          color:
                            isSelectedChoice(choice()) && currentThinking() === null
                              ? palette().primaryText
                              : palette().ink2,
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
                                ? palette().primaryBg
                                : palette().surface2,
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 12,
                              fontWeight: '600',
                              color:
                                isSelectedChoice(choice()) && currentThinking() === lvl()
                                  ? palette().primaryText
                                  : palette().ink2,
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
