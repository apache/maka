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

import { keyboardFrame, safeAreaInsets, Text, token, View, windowSize } from 'nsh';
import { AlertDialog } from 'nsh/base';
import { tr } from '../locale';
import { spacing, type } from '../theme/tokens';
import { ActionButton } from './ActionButton';

export function sheetInsets() {
  const insets = safeAreaInsets();
  const keyboardLift = () => Math.max(0, keyboardFrame().height - insets().bottom);
  return {
    // The header, rows and form controls already carry the usual page gutter.
    extraGutters: () => ({
      paddingLeft: Math.max(0, insets().left - spacing.pageX),
      paddingRight: Math.max(0, insets().right - spacing.pageX),
    }),
    // Sheet lifts by the keyboard height minus this inset.
    bottomPadding: () => Math.max(insets().bottom, 16),
    // Capture the owning page's frame: Sheet clears the local keyboard inset.
    keyboardBounds: () => {
      const lift = keyboardLift();
      return {
        bottom: lift || undefined,
        maxHeight: Math.max(0, windowSize().height - insets().top - lift),
      };
    },
  };
}

export function SheetHeader(props: {
  title: string;
  action: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.pageX,
        paddingVertical: 6,
        flexShrink: 0,
        gap: 8,
      }}
    >
      <Text
        role="header"
        style={{ ...type.headline, color: token('foreground'), flex: 1, minWidth: 0 }}
      >
        {props.title}
      </Text>
      <ActionButton
        title={props.action}
        variant="glassQuiet"
        compact
        pill
        minHeight={spacing.rowMinHeight}
        onPress={props.onPress}
        disabled={props.disabled}
      />
    </View>
  );
}

export async function confirmDiscard() {
  const { action } = await AlertDialog.show({
    title: tr('Discard changes?'),
    actions: [
      { id: 'cancel', label: tr('Cancel'), role: 'cancel' },
      { id: 'discard', label: tr('Discard'), role: 'destructive' },
    ],
  });
  return action === 'discard';
}
