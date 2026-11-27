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

import {
  effect,
  lifecycle,
  safeAreaInsets,
  Scroll,
  signal,
  Text,
  View,
  token,
  windowSize,
} from 'nsh';
import { Button, NavPage } from 'nsh/base';
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
import { glassSurfaceStyle } from '../../ui/Glass';

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
  const short = () => windowSize().height <= 430;
  const reticleSize = () => (short() ? 148 : Math.min(244, windowSize().width - 64));
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
      headerVisible={!showCamera()}
      headerShadowVisible={false}
      statusBar={showCamera() ? { foreground: 'light' } : undefined}
      header={
        showCamera() ? undefined : (
          <ScreenHeader title={tr('Scan QR Code')} backLabel={tr('Back')} onBack={props.onBack} />
        )
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
                console.warn('Could not start the camera', message);
                scanError.set(tr('Camera could not start.'));
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

        <If
          when={showCamera()}
          else={
            <Scroll
              style={{ flex: 1 }}
              contentStyle={{
                flexGrow: 1,
                alignItems: 'center',
                justifyContent: 'center',
                paddingTop: insets().top + 12,
                paddingBottom: Math.max(insets().bottom, 12),
                paddingLeft: Math.max(spacing.pageX, insets().left),
                paddingRight: Math.max(spacing.pageX, insets().right),
              }}
            >
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
                    backgroundColor: token(isUnavailable() ? 'primary-tint' : 'warning-tint'),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon
                    name="camera"
                    color={token(isUnavailable() ? 'primary' : 'warning')}
                    size={24}
                  />
                </View>
                <Text style={{ ...type.headline, color: token('foreground'), textAlign: 'center' }}>
                  {isUnavailable()
                    ? tr('Camera unavailable on this device')
                    : tr('Camera access required')}
                </Text>
                <Text
                  style={{
                    ...type.subheadline,
                    color: token('muted-foreground'),
                    textAlign: 'center',
                  }}
                >
                  {isUnavailable()
                    ? tr(
                        'This device or simulator has no camera. Paste a pairing link copied from Maka on your computer instead.',
                      )
                    : tr(
                        'Allow Maka to use the camera in iOS Settings to scan your computer’s QR code, or paste a pairing link.',
                      )}
                </Text>
                <View style={{ width: '100%', gap: 8, marginTop: 6 }}>
                  <If when={isDenied() && canOpenSettings()}>
                    <ActionButton
                      title={tr('Open Settings')}
                      variant="glassPrimary"
                      onPress={() => {
                        void AppSettings.open().catch(() => {});
                      }}
                    />
                  </If>
                  <ActionButton
                    title={tr('Paste pairing link')}
                    icon={isUnavailable() ? 'link' : undefined}
                    variant={isDenied() && canOpenSettings() ? 'glassSecondary' : 'glassPrimary'}
                    onPress={() => openAdvancedConnectSheet()}
                  />
                </View>
              </View>
            </Scroll>
          }
        >
          <View
            style={{
              flex: 1,
              paddingTop: insets().top + 8,
              paddingBottom: insets().bottom + 8,
              paddingLeft: Math.max(spacing.pageX, insets().left),
              paddingRight: Math.max(spacing.pageX, insets().right),
              gap: 8,
              pointerEvents: 'box-none',
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                minHeight: 44,
                pointerEvents: 'box-none',
              }}
            >
              <ScannerButton icon="chevronLeft" label={tr('Back')} onPress={props.onBack} />
              <If when={status() === 'ready'}>
                <ScannerButton
                  icon="torch"
                  label={torch() ? tr('Turn off flashlight') : tr('Turn on flashlight')}
                  selected={torch()}
                  onPress={() => {
                    hapticSelection();
                    torch.update((on) => !on);
                  }}
                />
              </If>
            </View>

            <Scroll
              style={{ flex: 1, minHeight: 0 }}
              contentStyle={{
                flexGrow: 1,
                flexDirection: short() ? 'row' : 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: short() ? 24 : 16,
              }}
            >
              <If
                when={scanError()}
                else={
                  <>
                    <View style={{ width: reticleSize(), height: reticleSize(), flexShrink: 0 }}>
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
                    <View
                      style={{
                        ...scannerGlassStyle(16),
                        flexShrink: 1,
                        maxWidth: 280,
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                      }}
                    >
                      <Text
                        style={{
                          ...type.subheadline,
                          color: token('glass-foreground'),
                          textAlign: 'center',
                        }}
                      >
                        {isPairingBusy()
                          ? tr('Checking pairing invite…')
                          : tr('Open Maka Settings on your computer to show the pairing QR code.')}
                      </Text>
                    </View>
                  </>
                }
              >
                <View
                  style={{
                    ...scannerGlassStyle(20),
                    padding: 12,
                    alignItems: 'center',
                    gap: 8,
                    maxWidth: 300,
                  }}
                >
                  <Text
                    style={{
                      ...type.footnote,
                      color: token('glass-foreground'),
                      textAlign: 'center',
                    }}
                  >
                    {scanError()}
                  </Text>
                  <ActionButton
                    title={tr('Scan again')}
                    variant="glassPrimary"
                    compact
                    minHeight={spacing.rowMinHeight}
                    onPress={() => {
                      if (status() === 'ready') {
                        scanError.set(null);
                        paused.set(false);
                      } else restart();
                    }}
                  />
                </View>
              </If>
            </Scroll>

            <View style={{ alignItems: 'center', pointerEvents: 'box-none' }}>
              <ScannerButton
                icon="link"
                label={tr('Paste pairing link')}
                showLabel
                onPress={() => {
                  hapticSelection();
                  openAdvancedConnectSheet();
                }}
              />
            </View>
          </View>
        </If>
      </View>
    </NavPage>
  );
}

function scannerGlassStyle(radius: number) {
  return { ...glassSurfaceStyle(radius), backgroundColor: token('scanner-glass-bg') };
}

function ScannerButton(props: {
  icon: 'chevronLeft' | 'torch' | 'link';
  label: string;
  showLabel?: boolean;
  selected?: boolean;
  onPress: () => void;
}) {
  const color = () => token(props.selected ? 'glass-accent' : 'glass-foreground');
  return (
    <Button
      accessibilityLabel={props.label}
      accessibilityState={{ pressed: props.selected }}
      onPress={props.onPress}
      activeStyle={{ backgroundColor: token('glass-action-pressed-bg') }}
      style={{
        ...scannerGlassStyle(22),
        backgroundColor: token(props.selected ? 'glass-action-bg' : 'scanner-glass-bg'),
        minHeight: spacing.rowMinHeight,
        minWidth: spacing.rowMinHeight,
        paddingHorizontal: props.showLabel ? 16 : 0,
        paddingVertical: props.showLabel ? 8 : 0,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <Icon name={props.icon} color={color()} size={20} />
      <If when={props.showLabel}>
        <Text
          style={{ ...type.subheadlineMedium, color: color(), flexShrink: 1, textAlign: 'center' }}
        >
          {props.label}
        </Text>
      </If>
    </Button>
  );
}
