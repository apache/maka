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

import { Clipboard, keyboardFrame, effect, Scroll, signal, Text, View, token } from 'nsh';
import { Button, Input, Sheet, type SheetDetent } from 'nsh/base';
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
import { confirmDiscard, SheetHeader, sheetInsets } from '../../ui/SheetHeader';

export function AdvancedConnectSheet(props: { onTicketReady: () => void }) {
  const layout = sheetInsets();
  const uri = signal('');
  const relayUrl = signal('');
  const relayToken = signal('');
  const showAdvanced = signal(false);
  const detent = signal<SheetDetent>('medium');

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
      const text = await Clipboard.readText();
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

  const dirty = () =>
    uri().trim() !== (currentIncomingPairUri() ?? '') ||
    !!(
      relayUrl() ||
      relayToken() ||
      wsEndpoint() ||
      wsRootId() ||
      wsBearer() ||
      wsClientInstance()
    );
  const canDismiss = () => !isPairingBusy() && !dirty();
  const close = () => {
    showAdvanced.set(false);
    detent.set('medium');
    closeAdvancedConnectSheet();
    uri.set(currentIncomingPairUri() ?? '');
    relayUrl.set('');
    relayToken.set('');
    wsEndpoint.set('');
    wsRootId.set('');
    wsBearer.set('');
    wsClientInstance.set('');
  };
  const done = async () => {
    if (isPairingBusy() || (dirty() && !(await confirmDiscard()))) return;
    close();
  };

  return (
    <Sheet
      open={isAdvancedSheetOpen()}
      accessibilityLabel={tr('Pair with Link')}
      detents={['medium', 'large']}
      detent={detent()}
      onDetentChange={(e) => detent.set(e.detent)}
      grabber={keyboardFrame().height === 0}
      grabberAccessibilityLabel={tr('Adjust sheet height')}
      closeOnSwipe={canDismiss()}
      closeOnEscape={canDismiss()}
      closeOnBackdropPress={canDismiss()}
      onOpenChange={({ open }) => {
        if (!open && canDismiss()) close();
      }}
      backdropStyle={{ backgroundColor: token('scrim') }}
      popupStyle={{
        ...layout.extraGutters(),
        ...layout.keyboardBounds(),
        backgroundColor: token('grouped-bg'),
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        borderCurve: 'continuous',
        paddingTop: 4,
      }}
      grabberStyle={{
        width: spacing.rowMinHeight,
        height: spacing.rowMinHeight,
        alignSelf: 'center',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      grabberContent={
        <View
          accessible={false}
          style={{
            pointerEvents: 'none',
            width: 36,
            height: 5,
            borderRadius: 3,
            backgroundColor: token('tertiary-foreground'),
          }}
        />
      }
    >
      <SheetHeader
        title={tr('Pair with Link')}
        action={tr('Done')}
        disabled={isPairingBusy()}
        onPress={() => void done()}
      />

      <Scroll
        testID="advanced-connect-form"
        style={{ flex: 1, minHeight: 0 }}
        contentStyle={{ paddingBottom: layout.bottomPadding() }}
        keyboardShouldPersistTaps="handled"
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
                minHeight: spacing.rowMinHeight,
                ...type.mono,
                color: token('foreground'),
                placeholderColor: token('muted-foreground'),
                backgroundColor: 'transparent',
              }}
            />
          </View>
          <GroupDivider inset={16} />
          <Button
            accessibilityLabel={tr('Paste from Clipboard')}
            onPress={() => void handlePaste()}
            activeStyle={{ backgroundColor: token('glass-action-pressed-bg') }}
            style={{
              minHeight: spacing.rowMinHeight,
              backgroundColor: token('surface-elevated'),
              paddingHorizontal: 16,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Icon name="clipboard" color={token('glass-accent')} size={17} />
            <Text style={{ ...type.bodyMedium, color: token('glass-accent') }}>
              {tr('Paste from Clipboard')}
            </Text>
          </Button>
        </InsetGroup>

        <View style={{ paddingHorizontal: spacing.pageX, marginBottom: 24 }}>
          <ActionButton
            variant="glassPrimary"
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
              const next = !showAdvanced();
              showAdvanced.set(next);
              detent.set(next ? 'large' : 'medium');
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
                  minHeight: spacing.rowMinHeight,
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
                masked
                onChange={({ value }) => relayToken.set(value)}
                style={{
                  minHeight: spacing.rowMinHeight,
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
                  minHeight: spacing.rowMinHeight,
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
                  minHeight: spacing.rowMinHeight,
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
                masked
                onChange={({ value }) => wsBearer.set(value)}
                style={{
                  minHeight: spacing.rowMinHeight,
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
                  minHeight: spacing.rowMinHeight,
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
              variant="glassSecondary"
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
