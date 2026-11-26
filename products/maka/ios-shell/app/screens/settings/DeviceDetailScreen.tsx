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

import { Clipboard, safeAreaInsets, Scroll, signal, Text, View, token, type JSX } from 'nsh';
import { AlertDialog, Input, NavPage } from 'nsh/base';
import { pathLabel } from '../../bridge';
import { tr } from '../../locale';
import {
  activeHostInfo,
  hostPath,
  checkHostConnection,
  connectSavedHost,
  devicePeerId,
  disconnectSavedHost,
  hostById,
  hostCheckMessage,
  hostConnectionState,
  hostStatusKind,
  hostStatusText,
  isHostConnected,
  openAddComputerFlow,
  savedHosts,
  removeSavedHost,
  showToast,
} from '../../state/hostPool';
import { hapticSelection } from '../../state/preferences';
import { spacing, type } from '../../theme/tokens';
import {
  ActionButton,
  BannerNotice,
  GroupDivider,
  GroupRow,
  Icon,
  InsetGroup,
  ScreenHeader,
  StatusDot,
} from '../../ui';

export function DeviceDetailScreen(props: {
  rootId: string;
  onBack: () => void;
  settings?: JSX.Element;
}) {
  const insets = safeAreaInsets();
  const showRelayAuth = signal(false);
  const relayToken = signal('');
  const relayUrl = signal('');
  const showDiagnostics = signal(false);
  const busy = signal(false);

  const host = () => hostById(props.rootId);
  const conn = () => activeHostInfo(props.rootId);
  const connState = () => hostConnectionState(props.rootId);

  const subtitle = () => {
    const info = conn();
    if (info) return tr('Connected') + ' · ' + pathLabel(hostPath(info.rootId), info.transport);
    return hostStatusText(props.rootId);
  };

  const connectionDetail = () => {
    const peer = host()?.peerId;
    return [host()?.relayUrls?.[0], peer && peer.slice(0, 8) + '…' + peer.slice(-4)]
      .filter(Boolean)
      .join(' · ');
  };
  const copyText = (value: string, label: string) => {
    if (!value) return;
    hapticSelection();
    void Clipboard.writeText(value);
    showToast(tr('{label} copied', { label }));
  };

  const handleConnect = async (withRelayToken = false) => {
    busy.set(true);
    try {
      const resolvedRelayUrl = relayUrl().trim() || host()?.relayUrls?.[0] || '';
      const ok = await connectSavedHost(
        props.rootId,
        withRelayToken ? resolvedRelayUrl : undefined,
        withRelayToken ? relayToken() : undefined,
      );
      if (ok && withRelayToken) {
        relayToken.set('');
        showRelayAuth.set(false);
      }
    } finally {
      busy.set(false);
    }
  };

  const handleDisconnect = async () => {
    busy.set(true);
    try {
      const ephemeral = host()?.ephemeral;
      if ((await disconnectSavedHost(props.rootId)) && ephemeral) props.onBack();
    } finally {
      busy.set(false);
    }
  };

  const handleRemove = async () => {
    const name = host()?.hostName ?? props.rootId;
    const { action } = await AlertDialog.show({
      title: tr('Remove {name}?', { name }),
      description: tr(
        'This iPhone will disconnect from this computer and forget its pairing credentials. You can pair it again anytime.',
      ),
      actions: [
        { id: 'cancel', label: tr('Cancel'), role: 'cancel' },
        { id: 'remove', label: tr('Remove'), role: 'destructive' },
      ],
    });
    if (action !== 'remove') return;
    busy.set(true);
    try {
      const ok = await removeSavedHost(props.rootId);
      if (ok) props.onBack();
    } finally {
      busy.set(false);
    }
  };

  return (
    <NavPage
      style={{ flex: 1 }}
      title={host()?.hostName ?? tr('Computer')}
      headerBackTitle={host()?.hostName}
      hidesBottomBarWhenPushed
      headerShadowVisible={false}
      header={
        <ScreenHeader
          title={host()?.hostName ?? tr('Computer')}
          backLabel={tr('Settings')}
          onBack={props.onBack}
        />
      }
    >
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        <Scroll
          style={{ flex: 1 }}
          contentStyle={{
            paddingTop: 20,
            paddingBottom: Math.max(insets().bottom, 20) + 28,
          }}
        >
          <If when={host()}>
            <If when={!props.settings}>
              {/* Identity Header */}
              <View
                style={{
                  alignItems: 'center',
                  paddingHorizontal: 24,
                  marginBottom: 24,
                  gap: 8,
                }}
              >
                <View
                  style={{
                    width: 58,
                    height: 58,
                    borderRadius: 16,
                    borderCurve: 'continuous',
                    backgroundColor: token('primary-tint'),
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 2,
                  }}
                >
                  <Icon name="laptop" color={token('primary')} size={28} />
                </View>
                <Text style={{ ...type.title2, color: token('foreground'), textAlign: 'center' }}>
                  {host()!.hostName}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <StatusDot kind={hostStatusKind(props.rootId)} size={8} />
                  <Text style={{ ...type.subheadline, color: token('muted-foreground') }}>
                    {subtitle()}
                  </Text>
                </View>
              </View>
            </If>
            <If when={connState().status === 'error'}>
              <BannerNotice
                tone="destructive"
                title={tr('Connection error')}
                detail={(connState() as { status: 'error'; error: string }).error}
              />
            </If>

            <If when={hostCheckMessage(props.rootId)}>
              <BannerNotice tone="info" title={hostCheckMessage(props.rootId)!} />
            </If>

            {/* Connection Controls */}
            <InsetGroup header={tr('Connection')}>
              <If when={props.settings}>
                <GroupRow
                  title={subtitle()}
                  subtitle={connectionDetail() || undefined}
                  leading={<StatusDot kind={hostStatusKind(props.rootId)} />}
                  divider
                />
              </If>
              <If
                when={isHostConnected(props.rootId)}
                else={
                  <View>
                    <GroupRow
                      title={
                        connState().status === 'connecting' ? tr('Connecting…') : tr('Reconnect')
                      }
                      tone="primary"
                      disabled={busy() || connState().status === 'connecting'}
                      divider
                      onPress={() => void handleConnect(false)}
                    />
                    <GroupRow
                      title={tr('Reconnect with relay token')}
                      accessibilityLabel={tr('Relay Bearer for {name}', {
                        name: host()!.hostName,
                      })}
                      chevron={!showRelayAuth()}
                      onPress={() => {
                        hapticSelection();
                        showRelayAuth.update((v) => !v);
                      }}
                    />
                    <If when={showRelayAuth()}>
                      <GroupDivider inset={16} />
                      <View style={{ padding: 16, gap: 12 }}>
                        <View style={{ gap: 4 }}>
                          <Text style={{ ...type.caption, color: token('muted-foreground') }}>
                            {tr('Relay URL (optional)')}
                          </Text>
                          <Input
                            accessibilityLabel={tr('Saved Host relay URL')}
                            value={relayUrl()}
                            placeholder={host()!.relayUrls?.[0] ?? 'https://relay.example.com'}
                            onChange={({ value }) => relayUrl.set(value)}
                            style={{
                              minHeight: 38,
                              paddingHorizontal: 10,
                              borderRadius: 8,
                              backgroundColor: token('grouped-bg'),
                              ...type.body,
                              color: token('foreground'),
                            }}
                          />
                        </View>
                        <View style={{ gap: 4 }}>
                          <Text style={{ ...type.caption, color: token('muted-foreground') }}>
                            {tr('Relay Bearer token')}
                          </Text>
                          <Input
                            accessibilityLabel={tr('Saved Host relay Bearer token')}
                            value={relayToken()}
                            placeholder={tr('Paste relay token')}
                            masked
                            onChange={({ value }) => relayToken.set(value)}
                            style={{
                              minHeight: 38,
                              paddingHorizontal: 10,
                              borderRadius: 8,
                              backgroundColor: token('grouped-bg'),
                              ...type.body,
                              color: token('foreground'),
                            }}
                          />
                        </View>
                        <ActionButton
                          title={tr('Connect with Bearer token')}
                          accessibilityLabel={tr('Connect with Bearer token')}
                          disabled={busy() || !relayToken().trim()}
                          compact
                          onPress={() => void handleConnect(true)}
                        />
                      </View>
                    </If>
                  </View>
                }
              >
                <GroupRow
                  title={tr('Check connection')}
                  tone="primary"
                  disabled={busy()}
                  divider
                  onPress={() => void checkHostConnection(props.rootId)}
                />
                <If
                  when={props.settings}
                  else={
                    <GroupRow
                      title={tr('Disconnect')}
                      disabled={busy()}
                      onPress={() => void handleDisconnect()}
                    />
                  }
                >
                  <View style={{ flexDirection: 'row', gap: 8, padding: 12 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <ActionButton
                        title={tr('Reconnect')}
                        variant="secondary"
                        compact
                        disabled={busy()}
                        onPress={() => void handleConnect()}
                      />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <ActionButton
                        title={tr('Disconnect')}
                        variant="secondary"
                        compact
                        disabled={busy()}
                        onPress={() => void handleDisconnect()}
                      />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <ActionButton
                        title={tr('Remove')}
                        variant="destructive"
                        compact
                        disabled={busy()}
                        onPress={() => void handleRemove()}
                      />
                    </View>
                  </View>
                </If>
              </If>
            </InsetGroup>

            {props.settings}
            {/* Diagnostics (collapsed by default on Settings detail) */}
            <InsetGroup header={tr('Diagnostics')}>
              <GroupRow
                title={tr('Connection details')}
                value={showDiagnostics() ? tr('Hide') : tr('Show')}
                divider={showDiagnostics()}
                onPress={() => {
                  hapticSelection();
                  showDiagnostics.update((v) => !v);
                }}
              />
              <If when={showDiagnostics()}>
                <GroupRow
                  title={tr('Root ID')}
                  subtitle={host()!.rootId}
                  divider
                  onPress={() => copyText(host()!.rootId, tr('Root ID'))}
                />
                <If when={host()!.peerId}>
                  <GroupRow
                    title={tr('Host Peer ID')}
                    subtitle={host()!.peerId}
                    divider
                    onPress={() => copyText(host()!.peerId, tr('Host Peer ID'))}
                  />
                </If>
                <If when={devicePeerId()}>
                  <GroupRow
                    title={tr('This iPhone Peer ID')}
                    subtitle={devicePeerId()}
                    divider={
                      (conn()?.endpoints.length ?? host()!.endpoints.length) > 0 ||
                      (host()!.relayUrls?.length ?? 0) > 0
                    }
                    onPress={() => copyText(devicePeerId(), tr('This iPhone Peer ID'))}
                  />
                </If>
                <If when={(conn()?.endpoints.length ?? host()!.endpoints.length) > 0}>
                  <GroupRow
                    title={tr('Endpoints')}
                    subtitle={(conn()?.endpoints ?? host()!.endpoints).join(', ')}
                    divider={(host()!.relayUrls?.length ?? 0) > 0}
                  />
                </If>
                <If when={(host()!.relayUrls?.length ?? 0) > 0}>
                  <GroupRow title={tr('Relays')} subtitle={host()!.relayUrls!.join(', ')} />
                </If>
              </If>
            </InsetGroup>
            <If when={!props.settings || !isHostConnected(props.rootId)}>
              <InsetGroup>
                <GroupRow
                  title={tr('Remove Computer')}
                  tone="destructive"
                  disabled={busy()}
                  onPress={() => void handleRemove()}
                />
              </InsetGroup>
            </If>
            <If when={savedHosts().length === 1}>
              <InsetGroup>
                <GroupRow
                  title={tr('Add Another Computer')}
                  tone="primary"
                  onPress={openAddComputerFlow}
                />
              </InsetGroup>
            </If>
          </If>
        </Scroll>
      </View>
    </NavPage>
  );
}
