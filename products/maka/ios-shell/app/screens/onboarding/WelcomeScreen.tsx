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

import { safeAreaInsets, Text, View, token } from 'nsh';
import { NavPage } from 'nsh/base';
import { isAvailable } from 'nsh/mobile';
import { tr } from '../../locale';
import { openAdvancedConnectSheet } from '../../state/hostPool';
import { hapticSelection } from '../../state/preferences';
import { spacing, type } from '../../theme/tokens';
import { ActionButton, Icon, ScreenHeader } from '../../ui';
import { LanguageHeaderButton } from './LanguageMenuTrigger';

export function WelcomeScreen(props: { onStartScan: () => void; onCloseModal?: () => void }) {
  const insets = safeAreaInsets();

  const closeButton = () =>
    props.onCloseModal ? (
      <View
        role="button"
        accessibilityLabel={tr('Close')}
        onPress={props.onCloseModal}
        class="active:opacity-60"
        style={{
          minHeight: 44,
          paddingHorizontal: 8,
          justifyContent: 'center',
        }}
      >
        <Text style={{ ...type.bodyMedium, color: token('primary') }}>{tr('Cancel')}</Text>
      </View>
    ) : undefined;

  return (
    <NavPage
      style={{ flex: 1 }}
      title={props.onCloseModal ? tr('Add Computer') : ''}
      headerTransparent
      headerShadowVisible={false}
      headerLeft={isAvailable ? closeButton() : undefined}
      headerRight={isAvailable && !props.onCloseModal ? <LanguageHeaderButton /> : undefined}
      header={
        isAvailable ? undefined : (
          <ScreenHeader
            title={props.onCloseModal ? tr('Add Computer') : 'Maka'}
            backLabel={props.onCloseModal ? tr('Cancel') : undefined}
            onBack={props.onCloseModal}
            trailing={props.onCloseModal ? undefined : <LanguageHeaderButton />}
          />
        )
      }
    >
      <View
        style={{
          flex: 1,
          backgroundColor: token('canvas'),
          paddingTop: insets().top + 24,
          paddingBottom: Math.max(insets().bottom, 20) + 12,
          paddingHorizontal: spacing.pageX + 4,
          justifyContent: 'space-between',
        }}
      >
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            paddingBottom: 32,
          }}
        >
          <View
            style={{
              width: 68,
              height: 68,
              borderRadius: 18,
              borderCurve: 'continuous',
              backgroundColor: token('primary-tint'),
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 6,
            }}
          >
            <Icon name="maka" color={token('primary')} size={34} strokeWidth={2.1} />
          </View>

          <Text
            style={{
              ...type.title2,
              color: token('foreground'),
              textAlign: 'center',
            }}
          >
            {props.onCloseModal
              ? tr('Connect another computer')
              : tr('Continue your work from any computer')}
          </Text>

          <Text
            style={{
              ...type.subheadline,
              color: token('muted-foreground'),
              textAlign: 'center',
              maxWidth: 300,
              lineHeight: 21,
            }}
          >
            {tr(
              'Pair your Mac, Windows, or Linux computer to check progress, handle approvals, and continue conversations from your iPhone.',
            )}
          </Text>
        </View>

        <View style={{ gap: 10 }}>
          <ActionButton
            title={tr('Scan QR code on computer')}
            icon="qr"
            onPress={() => {
              hapticSelection();
              props.onStartScan();
            }}
          />
          <ActionButton
            title={tr('Paste pairing link or connect manually')}
            variant="quiet"
            onPress={() => {
              hapticSelection();
              openAdvancedConnectSheet();
            }}
          />
        </View>
      </View>
    </NavPage>
  );
}
