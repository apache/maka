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

import { tr } from './locale';
import { Text, View } from 'nsh';
import type { YNode } from 'nsh';
import { Button } from 'nsh/base';
import { keymap } from 'nsh/keymap';
import { platform, windowSize } from 'nsh/device';
import { Icon } from './Icon';
import { sessionStatusCaption } from './sessionStatus';
import {
  controlsLeft,
  controlsRight,
  docked,
  ownTitleBar,
  TITLE_BAR_HEIGHT,
  windowDrag,
} from './chrome';

export const C = {
  background: '#161719',
  surface: '#202123',
  raised: '#2a2b2e',
  text: '#f0f1f3',
  secondary: '#c6c9ce',
  muted: '#969ba4',
  accent: '#8ab8f8',
  accentHover: '#b6d3ff',
  warning: '#e7b86b',
  danger: '#f48a8a',
  line: '#37393e',
};

// Cells have a fixed 16-point row; native pixels retain the prose leading.
export const bodyTextStyle = { fontSize: 14, lineHeight: platform.isTerminal ? 16 : 24 };
export const secondaryTextStyle = { fontSize: 13, lineHeight: platform.isTerminal ? 16 : 20 };
export const inputTextStyle = { fontSize: 14, lineHeight: platform.isTerminal ? 16 : 20 };
export const captionTextStyle = { fontSize: 13, lineHeight: 16 };
export const codeTextStyle = {
  fontFamily: 'monospace',
  fontSize: 13,
  lineHeight: platform.isTerminal ? 16 : 20,
};
// Rounded Input clipping rasterizes the editor on a cell surface.
export const inputBorderRadius = platform.isTerminal ? 0 : 8;
export const compact = () => windowSize().height < 480;
/** A control's name and its shortcut, in the keys of the platform the app runs on. */
export const shortcut = (label: string, keystroke: string) =>
  `${label} · ${keymap.label(keystroke)}`;
export const controlStyle = {
  minHeight: 32,
  paddingHorizontal: 12,
  paddingVertical: 8,
  borderRadius: 8,
  justifyContent: 'center',
} as const;
export const controlHoverStyle = { backgroundColor: C.raised };
export const controlFocusStyle = { backgroundColor: C.raised, borderColor: C.accent };
export const controlDisabledStyle = platform.isTerminal
  ? { backgroundColor: C.background }
  : { opacity: 0.4 };
export function Header(props: {
  title: string;
  workspace?: string;
  status?: 'loading' | 'stopping' | 'failed';
  commands(): void;
  browse?(): void;
  files?(): void;
  filesOpener?(node: YNode): void;
}) {
  const workspaceName = () => {
    const path = props.workspace;
    if (!path) return tr('Files');
    return (
      path
        .split(path.startsWith('/') ? '/' : /[\\/]/)
        .filter(Boolean)
        .at(-1) || path
    );
  };
  return (
    <View
      desktop={windowDrag}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 16 + controlsLeft(!docked.browser()),
        paddingRight: 16 + controlsRight(!docked.preview()),
        height: ownTitleBar
          ? TITLE_BAR_HEIGHT
          : !platform.isTerminal && !props.title && !props.status
            ? 32
            : compact()
              ? 32
              : 48,
        gap: 8,
        borderBottomWidth: !platform.isTerminal && !props.title && !props.status ? 0 : 1,
        borderBottomColor: C.line,
      }}
    >
      <Button
        onPress={props.commands}
        accessibilityLabel={tr('Open commands')}
        tooltip={shortcut(tr('Search commands'), 'mod+p')}
        style={{
          ...controlStyle,
          ...(platform.isTerminal
            ? {}
            : { width: 32, paddingHorizontal: 8, alignItems: 'center' as const }),
        }}
        hoverStyle={{ backgroundColor: C.surface }}
        focusStyle={{ backgroundColor: C.raised }}
        activeStyle={{ backgroundColor: C.line }}
      >
        <If when={platform.isTerminal} else={<Icon name="search" color={C.secondary} />}>
          <View pointerEvents="none" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ color: C.secondary, fontSize: 13 }}>{tr('Commands')}</Text>
            <Text style={{ color: C.muted, fontSize: 11 }}>{keymap.label('mod+p')}</Text>
          </View>
        </If>
      </Button>
      <If when={props.browse}>
        <Button
          onPress={props.browse}
          accessibilityLabel={tr('Browse sessions')}
          tooltip={shortcut(tr('Browse sessions'), 'mod+o')}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={{ backgroundColor: C.raised }}
        >
          <Icon name="sidebar" color={C.secondary} />
        </Button>
      </If>
      <Text numberOfLines={1} style={{ color: C.text, flex: 1, minWidth: 0, fontWeight: '500' }}>
        {props.title}
      </Text>
      <If when={props.files}>
        <Button
          accessibilityLabel={tr('Browse workspace files')}
          tooltip={props.workspace || tr('Browse workspace files')}
          ref={props.filesOpener}
          onPress={props.files}
          style={{
            ...controlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            maxWidth: 240,
            minWidth: 0,
            flexShrink: 1,
          }}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={{ backgroundColor: C.raised }}
        >
          <Icon name="folder" color={C.secondary} />
          <Text
            numberOfLines={1}
            style={{ ...captionTextStyle, color: C.secondary, minWidth: 0, flexShrink: 1 }}
          >
            {workspaceName()}
          </Text>
        </Button>
      </If>
      <If when={props.status}>
        <Text
          style={{
            ...captionTextStyle,
            color:
              props.status === 'failed'
                ? C.danger
                : props.status === 'stopping'
                  ? C.accent
                  : C.muted,
          }}
        >
          {props.status ? sessionStatusCaption[props.status] : ''}
        </Text>
      </If>
    </View>
  );
}
