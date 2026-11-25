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
import { tr } from './locale';
import { Action } from './ui';

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
        <Text class="text-xl font-semibold text-foreground">{tr('Connect to a Host')}</Text>
        <Action title={tr('Close')} onPress={props.onBack} />
      </View>
      <SegmentedControl
        items={[{ title: tr('Signed invite') }, { title: tr('WebSocket') }]}
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
            {tr(
              'Paste the invite link. Next, compare the pairing code with the one shown on the Host.',
            )}
          </Text>
          <Input
            accessibilityLabel={tr('Pairing URI input')}
            class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
            value={props.ticketUri()}
            onChange={({ value }) => props.onChangeUri(value)}
            placeholder="maka://pair/v1?payload=…"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Input
            accessibilityLabel={tr('Relay URL')}
            class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
            value={relayUrl()}
            onChange={({ value }) => relayUrl.set(value)}
            placeholder={tr('Relay URL (for authenticated relays)')}
            autoCapitalize="none"
          />
          <Input
            accessibilityLabel={tr('Relay Bearer token')}
            class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
            value={relayToken()}
            onChange={({ value }) => relayToken.set(value)}
            placeholder={tr('Relay Bearer (optional)')}
            masked
          />
          <Action
            title={props.busy() ? tr('Connecting…') : tr('Connect and compare')}
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
              {tr('Continue only if the code matches the one shown on the Host.')}
            </Text>
            <Text
              accessibilityLabel={tr('Live pairing code')}
              class="text-3xl font-mono text-foreground"
            >
              {props.parsedTicket()?.sasCode}
            </Text>
            <Action
              title={tr('Copy pairing code')}
              onPress={() => {
                const code = props.parsedTicket()?.sasCode;
                if (code) Clipboard.writeText(code).catch((err) => directError.set(String(err)));
              }}
            />
            <Action
              title={tr('Codes match — pair')}
              primary
              disabled={!editable()}
              onPress={props.onConfirm}
            />
          </View>
        </If>
      </If>
      <If when={mode() === 1}>
        <Text class="text-muted-foreground">
          {tr(
            'Use an authorized Bearer token. This mode does not redeem invites or save credentials.',
          )}
        </Text>
        <Input
          accessibilityLabel={tr('WebSocket URL')}
          class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
          placeholder="wss://host/runtime-host"
          value={endpoint()}
          onChange={({ value }) => endpoint.set(value)}
          autoCapitalize="none"
        />
        <Input
          accessibilityLabel={tr('Host Root ID')}
          class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
          placeholder={tr('Host Root ID')}
          value={rootId()}
          onChange={({ value }) => rootId.set(value)}
          autoCapitalize="none"
        />
        <Input
          accessibilityLabel={tr('WebSocket client instance')}
          class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
          placeholder={tr('Bound client instance (defaults to device Peer ID)')}
          value={clientInstance()}
          onChange={({ value }) => clientInstance.set(value)}
          autoCapitalize="none"
        />
        <Input
          accessibilityLabel={tr('WebSocket Bearer')}
          class="min-h-11 rounded-xl border border-border bg-card px-3 text-foreground"
          placeholder={tr('Bearer')}
          value={bearer()}
          onChange={({ value }) => bearer.set(value)}
          masked
        />
        <Action
          title={connecting() ? tr('Connecting…') : tr('Connect via WebSocket')}
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
