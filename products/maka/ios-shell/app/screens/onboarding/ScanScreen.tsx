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

import { effect, lifecycle, safeAreaInsets, signal, Text, View, token } from 'nsh';
import { NavPage } from 'nsh/base';
import { AppSettings } from 'nsh/mobile';
import { CodeScanner } from '../../CodeScanner';
import { tr } from '../../locale';
import {
  currentPairingError,
  isPairingBusy,
  isAdvancedSheetOpen,
  isValidPairUri,
  openAdvancedConnectSheet,
  startPairingFromUri,
} from '../../state/hostPool';
import { hapticNotification, hapticSelection } from '../../state/preferences';
import { spacing, type } from '../../theme/tokens';
import { ActionButton, Icon, ScreenHeader } from '../../ui';

type ScannerState = 'initializing' | 'ready' | 'denied' | 'restricted' | 'unavailable' | 'error';

function ReticleCorner(props: {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  borderTopWidth?: number;
  borderBottomWidth?: number;
  borderLeftWidth?: number;
  borderRightWidth?: number;
  borderTopLeftRadius?: number;
  borderTopRightRadius?: number;
  borderBottomLeftRadius?: number;
  borderBottomRightRadius?: number;
}) {
  return (
    <View
      accessibilityElementsHidden
      style={{
        position: 'absolute',
        width: 28,
        height: 28,
        borderColor: token('scanner-fg'),
        ...props,
      }}
    />
  );
}

export function ScanScreen(props: { onBack: () => void; onTicketReady: () => void }) {
  const insets = safeAreaInsets();
  const status = signal<ScannerState>('initializing');
  const torch = signal(false);
  const paused = signal(false);
  const scanError = signal<string | null>(null);
  const canOpenSettings = signal(false);

  void AppSettings.available().then(
    (available) => canOpenSettings.set(available),
    () => canOpenSettings.set(false),
  );

  const handleScan = async (raw: string) => {
    if (paused() || isPairingBusy()) return;
    paused.set(true);
    scanError.set(null);
    if (!isValidPairUri(raw)) {
      hapticNotification('warning');
      scanError.set(tr('This QR code is not a Maka pairing link.'));
      return;
    }
    hapticNotification('success');
    const ticket = await startPairingFromUri(raw);
    if (ticket) {
      props.onTicketReady();
    } else {
      scanError.set(currentPairingError() ?? tr('Pairing link expired or invalid.'));
    }
  };

  const restart = () => {
    status.set('initializing');
    scanError.set(null);
    paused.set(false);
  };
  let resumed = lifecycle() === 'active';
  effect(() => {
    const foreground = lifecycle() === 'active';
    if (foreground && !resumed) restart();
    resumed = foreground;
  });
  const isUnavailable = () => status() === 'unavailable';
  const isDenied = () => status() === 'denied' || status() === 'restricted';
  const showCamera = () => !isUnavailable() && !isDenied();
  const cameraMounted = () => showCamera() && status() !== 'error';

  return (
    <NavPage
      style={{ flex: 1 }}
      title={tr('Scan QR Code')}
      headerTransparent={showCamera()}
      headerShadowVisible={false}
      headerStyle={
        showCamera() ? { color: token('scanner-fg'), tintColor: token('scanner-fg') } : undefined
      }
      statusBar={showCamera() ? { foreground: 'light' } : undefined}
      header={
        <ScreenHeader title={tr('Scan QR Code')} backLabel={tr('Back')} onBack={props.onBack} />
      }
    >
      <View
        style={{
          flex: 1,
          backgroundColor: showCamera() ? token('scanner-bg') : token('grouped-bg'),
        }}
      >
        <If when={cameraMounted()}>
          <CodeScanner
            active={!isAdvancedSheetOpen() && lifecycle() === 'active'}
            torch={torch()}
            paused={paused()}
            onScan={({ value }) => {
              void handleScan(value);
            }}
            onStatus={({ state }) => {
              status.set(state);
            }}
            onError={({ code, message }) => {
              if (code === 'unavailable') status.set('unavailable');
              else if (code === 'denied') status.set('denied');
              else if (code === 'restricted') status.set('restricted');
              else {
                status.set('error');
                scanError.set(message || tr('Camera could not start.'));
              }
            }}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
            }}
          />
        </If>

        <View
          style={{
            flex: 1,
            paddingTop: insets().top + 56,
            paddingBottom: Math.max(insets().bottom, 20) + 16,
            paddingHorizontal: spacing.pageX + 4,
            justifyContent: 'space-between',
          }}
        >
          {/* Top toolbar row: Torch button when live camera is ready */}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', minHeight: 44 }}>
            <If when={status() === 'ready'}>
              <View
                role="button"
                accessibilityLabel={torch() ? tr('Turn off flashlight') : tr('Turn on flashlight')}
                onPress={() => {
                  hapticSelection();
                  torch.update((on) => !on);
                }}
                class="active:opacity-70"
                style={{
                  minWidth: 44,
                  minHeight: 44,
                  paddingHorizontal: 14,
                  borderRadius: 22,
                  backgroundColor: torch() ? token('primary') : token('scanner-pill'),
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <Icon name="torch" color={token('scanner-fg')} size={18} />
                <Text
                  style={{
                    ...type.footnote,
                    fontWeight: '600',
                    color: token('scanner-fg'),
                  }}
                >
                  {torch() ? tr('Flash On') : tr('Flash')}
                </Text>
              </View>
            </If>
          </View>

          {/* Center: Camera reticle OR Simulator / Permission Denied calm card */}
          <View style={{ alignItems: 'center', justifyContent: 'center', gap: 20 }}>
            <If when={isUnavailable()}>
              <View
                style={{
                  width: '100%',
                  maxWidth: 320,
                  padding: 24,
                  borderRadius: 18,
                  borderCurve: 'continuous',
                  backgroundColor: token('surface'),
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <View
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 14,
                    borderCurve: 'continuous',
                    backgroundColor: token('primary-tint'),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="camera" color={token('primary')} size={24} />
                </View>
                <Text style={{ ...type.headline, color: token('foreground'), textAlign: 'center' }}>
                  {tr('Camera unavailable on this device')}
                </Text>
                <Text
                  style={{
                    ...type.subheadline,
                    color: token('muted-foreground'),
                    textAlign: 'center',
                    maxWidth: 268,
                  }}
                >
                  {tr(
                    'This device or simulator has no camera. Paste a pairing link copied from Maka on your computer instead.',
                  )}
                </Text>
                <View style={{ width: '100%', marginTop: 6 }}>
                  <ActionButton
                    title={tr('Paste pairing link')}
                    icon="link"
                    onPress={() => openAdvancedConnectSheet()}
                  />
                </View>
              </View>
            </If>

            <If when={isDenied()}>
              <View
                style={{
                  width: '100%',
                  maxWidth: 320,
                  padding: 24,
                  borderRadius: 18,
                  borderCurve: 'continuous',
                  backgroundColor: token('surface'),
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <View
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 14,
                    borderCurve: 'continuous',
                    backgroundColor: token('warning-tint'),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="camera" color={token('warning')} size={24} />
                </View>
                <Text style={{ ...type.headline, color: token('foreground'), textAlign: 'center' }}>
                  {tr('Camera access required')}
                </Text>
                <Text
                  style={{
                    ...type.subheadline,
                    color: token('muted-foreground'),
                    textAlign: 'center',
                  }}
                >
                  {tr(
                    'Allow Maka to use the camera in iOS Settings to scan your computer’s QR code, or paste a pairing link.',
                  )}
                </Text>
                <View style={{ width: '100%', gap: 8, marginTop: 6 }}>
                  <If when={canOpenSettings()}>
                    <ActionButton
                      title={tr('Open Settings')}
                      onPress={() => {
                        void AppSettings.open().catch(() => {});
                      }}
                    />
                  </If>
                  <ActionButton
                    title={tr('Paste pairing link')}
                    variant={canOpenSettings() ? 'secondary' : 'primary'}
                    onPress={() => openAdvancedConnectSheet()}
                  />
                </View>
              </View>
            </If>

            <If when={showCamera()}>
              <View style={{ alignItems: 'center', gap: 20 }}>
                <View style={{ width: 244, height: 244, position: 'relative' }}>
                  <ReticleCorner
                    top={0}
                    left={0}
                    borderTopWidth={3.5}
                    borderLeftWidth={3.5}
                    borderTopLeftRadius={14}
                  />
                  <ReticleCorner
                    top={0}
                    right={0}
                    borderTopWidth={3.5}
                    borderRightWidth={3.5}
                    borderTopRightRadius={14}
                  />
                  <ReticleCorner
                    bottom={0}
                    left={0}
                    borderBottomWidth={3.5}
                    borderLeftWidth={3.5}
                    borderBottomLeftRadius={14}
                  />
                  <ReticleCorner
                    bottom={0}
                    right={0}
                    borderBottomWidth={3.5}
                    borderRightWidth={3.5}
                    borderBottomRightRadius={14}
                  />
                </View>

                <Text
                  style={{
                    ...type.subheadline,
                    color: token('scanner-fg'),
                    textAlign: 'center',
                    maxWidth: 280,
                    opacity: 0.9,
                  }}
                >
                  {isPairingBusy()
                    ? tr('Checking pairing invite…')
                    : tr('Open Maka Settings on your computer to show the pairing QR code.')}
                </Text>

                <If when={scanError()}>
                  <View
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                      borderRadius: 12,
                      borderCurve: 'continuous',
                      backgroundColor: token('scanner-pill'),
                      alignItems: 'center',
                      gap: 8,
                      maxWidth: 300,
                    }}
                  >
                    <Text
                      style={{
                        ...type.footnote,
                        color: token('scanner-fg'),
                        textAlign: 'center',
                      }}
                    >
                      {scanError()}
                    </Text>
                    <ActionButton
                      title={tr('Scan again')}
                      variant="primary"
                      compact
                      onPress={restart}
                    />
                  </View>
                </If>
              </View>
            </If>
          </View>

          {/* Bottom floating pill action */}
          <View style={{ alignItems: 'center' }}>
            <If when={showCamera()}>
              <View
                role="button"
                accessibilityLabel={tr('Paste pairing link')}
                onPress={() => {
                  hapticSelection();
                  openAdvancedConnectSheet();
                }}
                class="active:opacity-75"
                style={{
                  minHeight: 46,
                  paddingHorizontal: 20,
                  borderRadius: 23,
                  backgroundColor: token('scanner-pill'),
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <Icon name="link" color={token('scanner-fg')} size={17} />
                <Text
                  style={{
                    ...type.subheadlineMedium,
                    fontWeight: '600',
                    color: token('scanner-fg'),
                  }}
                >
                  {tr('Paste pairing link')}
                </Text>
              </View>
            </If>
          </View>
        </View>
      </View>
    </NavPage>
  );
}
