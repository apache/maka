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

import { Clipboard, effect, Scroll, signal, Text, View, token } from 'nsh';
import { Input, Sheet } from 'nsh/base';
import { tr } from '../../locale';
import {
  closeAdvancedConnectSheet,
  connectManualWebSocket,
  currentIncomingPairUri,
  currentPairingError,
  isAdvancedSheetOpen,
  isPairingBusy,
  startPairingFromUri,
} from '../../state/hostPool';
import { hapticSelection } from '../../state/preferences';
import { spacing, type } from '../../theme/tokens';
import { ActionButton, BannerNotice, GroupDivider, Icon, InsetGroup } from '../../ui';

export function AdvancedConnectSheet(props: { onTicketReady: () => void }) {
  const uri = signal('');
  const relayUrl = signal('');
  const relayToken = signal('');
  const showAdvanced = signal(false);

  // Direct WebSocket fields (tucked inside collapsible advanced section).
  const wsEndpoint = signal('');
  const wsRootId = signal('');
  const wsBearer = signal('');
  const wsClientInstance = signal('');

  effect(() => {
    const incoming = currentIncomingPairUri();
    if (incoming) {
      uri.set(incoming);
    }
  });

  const handlePaste = async () => {
    hapticSelection();
    try {
      const text = await Clipboard.getString();
      if (text) uri.set(text.trim());
    } catch {
      // Clipboard empty or denied.
    }
  };

  const handleBeginPairing = async () => {
    const ticket = await startPairingFromUri(uri(), relayUrl(), relayToken());
    if (ticket) {
      props.onTicketReady();
    }
  };

  const handleConnectWs = async () => {
    await connectManualWebSocket(wsEndpoint(), wsRootId(), wsBearer(), wsClientInstance());
  };

  return (
    <Sheet
      open={isAdvancedSheetOpen()}
      accessibilityLabel={tr('Pair with Link')}
      detents={['medium', 'large']}
      defaultDetent="large"
      grabber
      closeOnSwipe
      onOpenChange={({ open }) => {
        if (!open) closeAdvancedConnectSheet();
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
      {/* Sheet Header */}
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
        <Text style={{ ...type.headline, color: token('foreground') }}>{tr('Pair with Link')}</Text>
        <View
          role="button"
          accessibilityLabel={tr('Close')}
          onPress={closeAdvancedConnectSheet}
          class="active:opacity-60"
          style={{
            minHeight: 36,
            paddingHorizontal: 10,
            justifyContent: 'center',
          }}
        >
          <Text style={{ ...type.bodyMedium, color: token('primary') }}>{tr('Done')}</Text>
        </View>
      </View>

      <Scroll
        style={{ flex: 1 }}
        keyboardDismissMode="interactive"
        contentContainerStyle={{ paddingBottom: 36 }}
      >
        <If when={currentPairingError()}>
          <BannerNotice tone="destructive" title={currentPairingError()!} />
        </If>

        {/* Primary Pairing Link Section */}
        <InsetGroup
          elevated
          header={tr('Pairing link')}
          footer={tr(
            'Copy a pairing link from Maka Settings on your computer, then paste it here.',
          )}
        >
          <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 8 }}>
            <Input
              accessibilityLabel={tr('Pairing URI input')}
              value={uri()}
              placeholder="maka://pair/v1?payload=…"
              onChange={({ value }) => uri.set(value)}
              style={{
                minHeight: 40,
                ...type.mono,
                color: token('foreground'),
                backgroundColor: 'transparent',
              }}
            />
          </View>
          <GroupDivider inset={16} />
          <View
            role="button"
            accessibilityLabel={tr('Paste from Clipboard')}
            onPress={() => void handlePaste()}
            class="active:bg-row-pressed"
            style={{
              minHeight: 44,
              paddingHorizontal: 16,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Icon name="clipboard" color={token('primary')} size={17} />
            <Text style={{ ...type.bodyMedium, color: token('primary') }}>
              {tr('Paste from Clipboard')}
            </Text>
          </View>
        </InsetGroup>

        <View style={{ paddingHorizontal: spacing.pageX, marginBottom: 24 }}>
          <ActionButton
            title={isPairingBusy() ? tr('Connecting…') : tr('Connect and compare')}
            accessibilityLabel={tr('Connect and compare')}
            disabled={isPairingBusy() || !uri().trim()}
            onPress={() => void handleBeginPairing()}
          />
        </View>

        {/* Collapsible Advanced Options (Custom Relay + Direct WebSocket) */}
        <InsetGroup elevated header={tr('Advanced options')}>
          <View
            role="button"
            accessibilityLabel={tr('Custom relay or WebSocket')}
            onPress={() => {
              hapticSelection();
              showAdvanced.update((v) => !v);
            }}
            class="active:bg-row-pressed"
            style={{
              minHeight: 46,
              paddingHorizontal: 16,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text style={{ ...type.body, color: token('foreground') }}>
              {tr('Custom relay or WebSocket')}
            </Text>
            <Icon
              name={showAdvanced() ? 'chevronDown' : 'chevronRight'}
              color={token('tertiary-foreground')}
              size={16}
            />
          </View>

          <If when={showAdvanced()}>
            <GroupDivider inset={16} />
            <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 4 }}>
              <Text style={{ ...type.caption, color: token('muted-foreground') }}>
                {tr('Relay URL')}
              </Text>
              <Input
                accessibilityLabel={tr('Relay URL')}
                value={relayUrl()}
                placeholder="https://relay.example.com"
                onChange={({ value }) => relayUrl.set(value)}
                style={{
                  minHeight: 38,
                  ...type.body,
                  color: token('foreground'),
                  backgroundColor: 'transparent',
                }}
              />
            </View>
            <GroupDivider inset={16} />
            <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 4 }}>
              <Text style={{ ...type.caption, color: token('muted-foreground') }}>
                {tr('Relay Bearer token')}
              </Text>
              <Input
                accessibilityLabel={tr('Relay Bearer token')}
                value={relayToken()}
                placeholder={tr('Optional token')}
                secureTextEntry
                onChange={({ value }) => relayToken.set(value)}
                style={{
                  minHeight: 38,
                  ...type.body,
                  color: token('foreground'),
                  backgroundColor: 'transparent',
                }}
              />
            </View>
          </If>
        </InsetGroup>

        <If when={showAdvanced()}>
          <InsetGroup
            elevated
            header={tr('Direct WebSocket')}
            footer={tr('Connect directly to a Host exposing a WebSocket endpoint.')}
          >
            <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 4 }}>
              <Text style={{ ...type.caption, color: token('muted-foreground') }}>
                {tr('Endpoint URL')}
              </Text>
              <Input
                accessibilityLabel={tr('WebSocket endpoint')}
                value={wsEndpoint()}
                placeholder="wss://host.local:8443"
                onChange={({ value }) => wsEndpoint.set(value)}
                style={{
                  minHeight: 38,
                  ...type.mono,
                  color: token('foreground'),
                  backgroundColor: 'transparent',
                }}
              />
            </View>
            <GroupDivider inset={16} />
            <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 4 }}>
              <Text style={{ ...type.caption, color: token('muted-foreground') }}>
                {tr('Root ID')}
              </Text>
              <Input
                accessibilityLabel={tr('Root ID')}
                value={wsRootId()}
                placeholder="root-id"
                onChange={({ value }) => wsRootId.set(value)}
                style={{
                  minHeight: 38,
                  ...type.mono,
                  color: token('foreground'),
                  backgroundColor: 'transparent',
                }}
              />
            </View>
            <GroupDivider inset={16} />
            <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 4 }}>
              <Text style={{ ...type.caption, color: token('muted-foreground') }}>
                {tr('Bearer token')}
              </Text>
              <Input
                accessibilityLabel={tr('Bearer token')}
                value={wsBearer()}
                placeholder={tr('Required token')}
                secureTextEntry
                onChange={({ value }) => wsBearer.set(value)}
                style={{
                  minHeight: 38,
                  ...type.mono,
                  color: token('foreground'),
                  backgroundColor: 'transparent',
                }}
              />
            </View>
            <GroupDivider inset={16} />
            <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 4 }}>
              <Text style={{ ...type.caption, color: token('muted-foreground') }}>
                {tr('Client instance (optional)')}
              </Text>
              <Input
                accessibilityLabel={tr('Client instance')}
                value={wsClientInstance()}
                placeholder={tr('Defaults to device Peer ID')}
                onChange={({ value }) => wsClientInstance.set(value)}
                style={{
                  minHeight: 38,
                  ...type.mono,
                  color: token('foreground'),
                  backgroundColor: 'transparent',
                }}
              />
            </View>
          </InsetGroup>

          <View style={{ paddingHorizontal: spacing.pageX }}>
            <ActionButton
              title={tr('Connect via WebSocket')}
              variant="secondary"
              disabled={
                isPairingBusy() || !wsEndpoint().trim() || !wsRootId().trim() || !wsBearer().trim()
              }
              onPress={() => void handleConnectWs()}
            />
          </View>
        </If>
      </Scroll>
    </Sheet>
  );
}
