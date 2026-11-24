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

import { Clipboard, Scroll, Text, View, signal } from 'nsh';
import { Input } from 'nsh/base';
import { Haptics, SegmentedControl } from 'nsh/mobile';
import type { HostStateSnapshot, ParsedTicketInfo } from './bridge';
import { connectWebSocket, pathLabel } from './bridge';
import { Action } from './ui';
import { copy } from './copy';

export function PairingOverlay(props: {
  ticketUri: () => string;
  onChangeUri: (uri: string) => void;
  parsedTicket: () => ParsedTicketInfo | null;
  pairingError: () => string | null;
  busy: () => boolean;
  onParse: (relayUrl?: string, relayToken?: string) => void;
  onConfirm: () => void;
  onBack: () => void;
  connectionGeneration: () => number;
  onDirectConnect: (state: HostStateSnapshot) => void;
}) {
  const mode = signal(0);
  const relayUrl = signal('');
  const relayToken = signal('');
  const endpoint = signal('');
  const rootId = signal('');
  const bearer = signal('');
  const clientInstance = signal('');
  const connecting = signal(false);
  const directError = signal<string | null>(null);
  const editable = () => !props.busy() && !connecting();
  const connect = async () => {
    const generation = props.connectionGeneration();
    connecting.set(true);
    directError.set(null);
    try {
      const state = await connectWebSocket(
        endpoint().trim(),
        rootId().trim(),
        bearer(),
        clientInstance().trim() || undefined,
      );
      if (generation !== props.connectionGeneration()) return;
      bearer.set('');
      Haptics.notification('success');
      props.onDirectConnect(state);
    } catch (err) {
      if (generation !== props.connectionGeneration()) return;
      Haptics.notification('error');
      directError.set(String(err));
    } finally {
      connecting.set(false);
    }
  };

  return (
    <Scroll class="flex-1" contentClass="gap-4 p-5">
      <View class="flex-row items-center justify-between gap-4">
        <Text class="text-xl font-semibold text-foreground">
          {copy('Connect to a Host', '连接远端电脑', '連接遠端電腦')}
        </Text>
        <Action title={copy('Close', '关闭', '關閉')} onPress={props.onBack} />
      </View>
      <SegmentedControl
        items={[{ title: copy('Signed invite', '签名邀请', '簽署邀請') }, { title: 'WebSocket' }]}
        testID="pairing-mode"
        selectedIndex={mode()}
        disabled={!editable() || !!props.parsedTicket()}
        onChange={({ index }) => {
          Haptics.selection();
          mode.set(index);
        }}
      />
      <If when={mode() === 0}>
        <If when={!props.parsedTicket()}>
          <Text class="text-muted-foreground">
            {copy(
              'Paste the invite link. Next, compare the pairing code with the one shown on the Host.',
              '粘贴邀请链接。下一步会显示需要和 Host 对照的验证码。',
              '貼上邀請連結。下一步會顯示需要和 Host 核對的驗證碼。',
            )}
          </Text>
          <Input
            accessibilityLabel="Pairing URI input"
            class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
            value={props.ticketUri()}
            onChange={({ value }) => props.onChangeUri(value)}
            placeholder="maka://pair/v1?payload=…"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Input
            accessibilityLabel="Relay URL"
            class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
            value={relayUrl()}
            onChange={({ value }) => relayUrl.set(value)}
            placeholder={copy(
              'Relay URL (for authenticated relays)',
              'Relay URL（授权时填写）',
              'Relay URL（授權時填寫）',
            )}
            autoCapitalize="none"
          />
          <Input
            accessibilityLabel="Relay Bearer token"
            class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
            value={relayToken()}
            onChange={({ value }) => relayToken.set(value)}
            placeholder={copy(
              'Relay Bearer (optional)',
              'Relay Bearer（可选）',
              'Relay Bearer（選填）',
            )}
            masked
          />
          <Action
            title={
              props.busy()
                ? copy('Connecting…', '正在连接…', '正在連接…')
                : copy('Connect and compare', '连接并核对', '連接並核對')
            }
            primary
            disabled={!editable() || !props.ticketUri().trim()}
            onPress={() => props.onParse(relayUrl().trim() || undefined, relayToken() || undefined)}
          />
        </If>
        <If when={props.parsedTicket()}>
          <View class="gap-3 rounded-2xl bg-card p-4">
            <Text class="text-lg font-semibold text-foreground">
              {props.parsedTicket()?.hostName}
            </Text>
            <Text class="text-sm text-muted-foreground">
              {pathLabel(props.parsedTicket()?.pathSummary)}
            </Text>
            <Text class="text-muted-foreground">
              {copy(
                'Continue only if the code matches the one shown on the Host.',
                '只有与 Host 显示的验证码一致时才继续。',
                '只有與 Host 顯示的驗證碼一致時才繼續。',
              )}
            </Text>
            <Text accessibilityLabel="Live pairing code" class="text-3xl font-mono text-foreground">
              {props.parsedTicket()?.sasCode}
            </Text>
            <Action
              title={copy('Copy pairing code', '复制验证码', '複製驗證碼')}
              onPress={() => {
                const code = props.parsedTicket()?.sasCode;
                if (code) Clipboard.writeText(code).catch((err) => directError.set(String(err)));
              }}
            />
            <Action
              title={copy('Codes match — pair', '验证码一致，确认配对', '驗證碼一致，確認配對')}
              primary
              disabled={!editable()}
              onPress={props.onConfirm}
            />
          </View>
        </If>
      </If>
      <If when={mode() === 1}>
        <Text class="text-muted-foreground">
          {copy(
            'Use an authorized Bearer token. This mode does not redeem invites or save credentials.',
            '使用已授权的 Bearer；此模式不兑换签名邀请，也不保存凭据。',
            '使用已授權的 Bearer；此模式不兌換簽署邀請，也不儲存憑證。',
          )}
        </Text>
        <Input
          accessibilityLabel="WebSocket URL"
          class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
          placeholder="wss://host/runtime-host"
          value={endpoint()}
          onChange={({ value }) => endpoint.set(value)}
          autoCapitalize="none"
        />
        <Input
          accessibilityLabel="Host Root ID"
          class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
          placeholder="Host Root ID"
          value={rootId()}
          onChange={({ value }) => rootId.set(value)}
          autoCapitalize="none"
        />
        <Input
          accessibilityLabel="WebSocket client instance"
          class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
          placeholder={copy(
            'Bound client instance (defaults to device Peer ID)',
            '已绑定的 Client Instance（默认设备 Peer ID）',
            '已綁定的 Client Instance（預設為裝置 Peer ID）',
          )}
          value={clientInstance()}
          onChange={({ value }) => clientInstance.set(value)}
          autoCapitalize="none"
        />
        <Input
          accessibilityLabel="WebSocket Bearer"
          class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
          placeholder="Bearer"
          value={bearer()}
          onChange={({ value }) => bearer.set(value)}
          masked
        />
        <Action
          title={
            connecting()
              ? copy('Connecting…', '正在连接…', '正在連接…')
              : copy('Connect via WebSocket', '连接 WebSocket', '連接 WebSocket')
          }
          primary
          disabled={!editable() || !endpoint().trim() || !rootId().trim() || !bearer()}
          onPress={connect}
        />
      </If>
      <If when={props.pairingError() || directError()}>
        <Text accessibilityRole="alert" class="text-destructive">
          {props.pairingError() || directError()}
        </Text>
      </If>
    </Scroll>
  );
}
