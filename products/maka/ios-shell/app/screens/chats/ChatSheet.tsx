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
  keyboardFrame,
  safeArea,
  Scroll,
  token,
  View,
  windowSize,
  type JSX,
  type ScrollRef,
} from 'nsh';
import { Sheet } from 'nsh/base';
import { tr } from '../../locale';
import { spacing } from '../../theme/tokens';
import { ActionButton } from '../../ui';

export function ChatSheet(props: {
  title: string;
  scrollId: string;
  onClose: () => void;
  editing?: boolean;
  ownHeader?: boolean;
  detent?: { fraction: number };
  scrollRef?: (ref: ScrollRef) => void;
  children: JSX.Element;
}) {
  // A Sheet is laid out in the modal window, not in the owning page's insets.
  const insets = safeArea;
  const keyboardHeight = () => keyboardFrame().height;
  const availableHeight = () =>
    Math.max(
      0,
      windowSize().height -
        insets().top -
        (keyboardHeight() || (props.detent ? 0 : insets().bottom)),
    );
  return (
    <Sheet
      open
      accessibilityLabel={props.title}
      closeOnSwipe={!props.editing}
      closeOnBackdropPress={!props.editing}
      closeOnEscape={!props.editing}
      detents={
        props.detent ? [keyboardHeight() ? { height: availableHeight() } : props.detent] : []
      }
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      backdropStyle={props.detent ? { backgroundColor: token('scrim') } : undefined}
      popupStyle={{
        backgroundColor: token('grouped-bg'),
        paddingTop: 8,
        paddingBottom: 8 + (props.detent && !keyboardHeight() ? insets().bottom : 0),
        bottom: keyboardHeight() || undefined,
        borderCurve: 'continuous',
        borderTopLeftRadius: props.detent ? spacing.panelRadius : undefined,
        borderTopRightRadius: props.detent ? spacing.panelRadius : undefined,
        paddingLeft: Math.max(spacing.pageX, insets().left),
        paddingRight: Math.max(spacing.pageX, insets().right),
        maxHeight: availableHeight(),
      }}
    >
      <If when={!props.ownHeader && !props.editing}>
        <View style={{ alignItems: 'flex-end', flexShrink: 0 }}>
          <ActionButton
            title={tr('Done')}
            variant="glassQuiet"
            compact
            minHeight={spacing.rowMinHeight}
            onPress={props.onClose}
          />
        </View>
      </If>
      <Scroll
        ref={props.scrollRef}
        testID={props.scrollId}
        style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={props.detent ? 'interactive' : undefined}
      >
        {props.children}
      </Scroll>
    </Sheet>
  );
}
