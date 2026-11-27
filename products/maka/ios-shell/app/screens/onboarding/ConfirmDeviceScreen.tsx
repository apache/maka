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

import { Clipboard, safeAreaInsets, Scroll, signal, Text, View, token } from 'nsh';
import { Input, NavPage } from 'nsh/base';
import { isAvailable } from 'nsh/mobile';
import { pathLabel } from '../../bridge';
import { tr } from '../../locale';
import {
  cancelActivePairing,
  confirmPendingPairing,
  currentDeviceLabel,
  currentPairingError,
  currentPendingTicket,
  isPairingBusy,
  setDeviceLabel,
  showToast,
} from '../../state/hostPool';
import { hapticSelection } from '../../state/preferences';
import { spacing, type } from '../../theme/tokens';
import { ActionButton, BannerNotice, Icon, InsetGroup, ScreenHeader } from '../../ui';

export function ConfirmDeviceScreen(props: { onCancelled: () => void; onConfirmed: () => void }) {
  const insets = safeAreaInsets();
  const ticket = () => currentPendingTicket();
  const editedName = signal<string | null>(null);
  const computerName = () => editedName() ?? ticket()?.hostName ?? '';
  const nameInputStyle = {
    minHeight: 46,
    paddingHorizontal: 16,
    ...type.body,
    color: token('foreground'),
    backgroundColor: 'transparent',
  } as const;

  const handleCancel = async () => {
    if (isPairingBusy()) return;
    await cancelActivePairing();
    props.onCancelled();
  };

  const handleConfirm = async () => {
    const ok = await confirmPendingPairing(editedName());
    if (ok) props.onConfirmed();
  };

  return (
    <NavPage
      style={{ flex: 1 }}
      title={tr('Confirm Computer')}
      headerShadowVisible={false}
      headerBackVisible={false}
      headerRight={
        isAvailable ? (
          <View
            role="button"
            accessibilityLabel={tr('Close')}
            disabled={isPairingBusy()}
            onPress={() => void handleCancel()}
            class="active:opacity-60"
            style={{ minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' }}
          >
            <Text style={{ ...type.body, color: token('primary') }}>{tr('Cancel')}</Text>
          </View>
        ) : undefined
      }
      header={
        isAvailable ? undefined : (
          <ScreenHeader
            title={tr('Confirm Computer')}
            trailing={
              <View
                role="button"
                accessibilityLabel={tr('Close')}
                disabled={isPairingBusy()}
                onPress={() => void handleCancel()}
                style={{ minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' }}
              >
                <Text style={{ ...type.body, color: token('primary') }}>{tr('Cancel')}</Text>
              </View>
            }
          />
        )
      }
    >
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        <Scroll
          style={{ flex: 1 }}
          contentStyle={{
            paddingTop: 24,
            paddingBottom: Math.max(insets().bottom, 20) + 24,
          }}
        >
          <If when={ticket()}>
            {/* Computer Identity Hero */}
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
                  marginBottom: 4,
                }}
              >
                <Icon name="laptop" color={token('primary')} size={28} />
              </View>
              <Text
                style={{
                  ...type.title2,
                  color: token('foreground'),
                  textAlign: 'center',
                }}
              >
                {computerName().trim() || tr('Computer')}
              </Text>
              <Text
                style={{
                  ...type.subheadline,
                  color: token('muted-foreground'),
                  textAlign: 'center',
                }}
              >
                {[ticket()!.platform, pathLabel(ticket()!.pathSummary)].filter(Boolean).join(' · ')}
              </Text>
            </View>

            {/* Verification Code (SAS) */}
            <InsetGroup
              header={tr('Verification code')}
              footer={tr('Continue only if this code matches the one displayed on your computer.')}
            >
              <View
                role="button"
                accessibilityLabel={tr('Verification code')}
                onPress={() => {
                  const code = ticket()?.sasCode;
                  if (!code) return;
                  hapticSelection();
                  void Clipboard.writeText(code);
                  showToast(tr('Verification code copied'));
                }}
                class="active:bg-row-pressed"
                style={{
                  paddingVertical: 22,
                  paddingHorizontal: 16,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <Text
                  style={{
                    ...type.sasCode,
                    fontVariant: ['tabular-nums'],
                    color: token('foreground'),
                    textAlign: 'center',
                  }}
                >
                  {ticket()!.sasCode}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Icon name="copy" color={token('primary')} size={13} />
                  <Text style={{ ...type.caption, color: token('primary') }}>
                    {tr('Tap to copy')}
                  </Text>
                </View>
              </View>
            </InsetGroup>

            <InsetGroup header={tr('Computer name')}>
              <Input
                accessibilityLabel={tr('Computer name')}
                value={computerName()}
                disabled={isPairingBusy()}
                onChange={({ value }) => editedName.set(value)}
                style={nameInputStyle}
              />
            </InsetGroup>

            {/* Editable iPhone Label */}
            <InsetGroup
              header={tr('This iPhone')}
              footer={tr(
                'A friendly label to help identify this iPhone in your computer settings.',
              )}
            >
              <Input
                accessibilityLabel={tr('Device name')}
                value={currentDeviceLabel()}
                placeholder={tr('iPhone')}
                disabled={isPairingBusy()}
                onChange={({ value }) => setDeviceLabel(value)}
                style={nameInputStyle}
              />
            </InsetGroup>

            <If when={currentPairingError()}>
              <BannerNotice tone="destructive" title={currentPairingError()!} />
            </If>

            {/* Confirm & Cancel CTAs */}
            <View style={{ paddingHorizontal: spacing.pageX, gap: 10, marginTop: 4 }}>
              <ActionButton
                title={isPairingBusy() ? tr('Connecting…') : tr('Confirm & Connect')}
                accessibilityLabel={tr('Confirm & Connect')}
                disabled={isPairingBusy()}
                onPress={() => void handleConfirm()}
              />
              <ActionButton
                title={tr('Cancel')}
                disabled={isPairingBusy()}
                variant="quiet"
                onPress={() => void handleCancel()}
              />
            </View>
          </If>
        </Scroll>
      </View>
    </NavPage>
  );
}
