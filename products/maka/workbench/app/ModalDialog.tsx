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

import { platform, Text, View, windowSize, type JSX, type ViewStyle } from 'nsh';
import { Dialog } from 'nsh/base';
import { dialogTop } from './chrome';
import { C } from './ui';

const WIDTHS = { alert: 400, form: 520, editor: 720, page: 880 } as const;

/**
 * A modal over the window: the scrim and the card every dialog shares. The
 * card keeps `surface`, the fill its controls' `raised` and `background` are
 * set against, and takes the floating family's line, radius and shadow. `onCancel` gets Escape and a press on the scrim; the caller closes.
 * `height` makes it fill the window up to that height, for editors and pages;
 * a launcher opens an eighth of the window down so typing does not move it.
 */
export function ModalDialog(props: {
  size: keyof typeof WIDTHS;
  height?: number;
  launcher?: boolean;
  onCancel(): void;
  style?: ViewStyle;
  /** In the modal's scope but outside the card: menus its rows open. */
  outside?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <Dialog
      animation="none"
      closeOnEscape={false}
      closeOnBackdropPress={false}
      closeOnSwipe={false}
      onCancel={props.onCancel}
      style={{
        flex: 1,
        justifyContent: props.launcher ? 'flex-start' : 'center',
        alignItems: 'center',
        padding: 16,
        paddingTop:
          props.launcher && windowSize().height >= 480 ? windowSize().height / 8 : dialogTop(16),
        backgroundColor: C.scrim,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: WIDTHS[props.size],
          maxHeight: props.height ?? '100%',
          minHeight: 0,
          ...(props.height === undefined ? {} : { flex: 1 }),
          padding: 16,
          gap: 16,
          ...dialogCardStyle(),
          ...props.style,
        }}
      >
        {props.children}
      </View>
      {props.outside}
    </Dialog>
  );
}

/** The card of a dialog that lays out its own scrim: `ModalDialog` uses it too. */
export const dialogCardStyle = () => ({
  backgroundColor: C.surface,
  borderWidth: 1,
  borderColor: C.line,
  borderRadius: 12,
  ...(platform.idiom === 'terminal' ? {} : { boxShadow: `0 16px 48px ${C.shadow}` }),
});

/** The decision and its object as the title; `detail` adds only what changes it. */
export function DialogHeader(props: { title: string; detail?: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text
        role="header"
        style={[{ ...textStyle, fontWeight: '600', color: C.text }, { numberOfLines: 2 }]}
      >
        {props.title}
      </Text>
      <If when={props.detail}>
        <Text style={{ ...textStyle, color: C.secondary }}>{props.detail}</Text>
      </If>
    </View>
  );
}

/** Actions at the bottom right: Cancel, then the result. */
export function DialogFooter(props: { children: JSX.Element }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
      }}
    >
      {props.children}
    </View>
  );
}

const textStyle = { fontSize: 14, lineHeight: platform.idiom === 'terminal' ? 16 : 20 };
