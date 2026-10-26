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
import { Button, Tooltip } from 'nsh/base';
import { platform, windowSize } from 'nsh';
import { Icon } from './Icon';
import { sessionStatusCaption } from './sessionStatus';


export function textTooltip(text: () => string | undefined): YNode {
  return (
    <Tooltip disabled={!text()} class="rounded-md border border-border bg-popover px-2 py-1">
      <Text class="text-xs text-popover-foreground">{text()}</Text>
    </Tooltip>
  );
}

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
export type BrowserHeader = {
  expanded: boolean;
  hidden: boolean;
  toggle(): void;
};
export function Header(props: {
  title: string;
  workspace?: string;
  status?: 'loading' | 'stopping' | 'failed';
  commands(): void;
  browser: BrowserHeader;
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
      accessibilityElementsHidden={props.browser.hidden}
      pointerEvents={props.browser.hidden ? 'none' : 'auto'}
      style={{
        opacity: props.browser.hidden ? 0 : 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        height: !platform.isTerminal && !props.title && !props.status ? 32 : compact() ? 32 : 48,
        gap: 8,
        borderBottomWidth: !platform.isTerminal && !props.title && !props.status ? 0 : 1,
        borderBottomColor: C.line,
      }}
    >
      <Button
        class="group/sidebar-toggle"
        onPress={props.browser.toggle}
        accessibilityLabel={
          props.browser.expanded ? tr('Collapse session browser') : tr('Expand session browser')
        }
        tooltip={textTooltip(() => props.browser.expanded ? tr('Collapse session browser') : tr('Expand session browser'))}
        selected={props.browser.expanded}
        style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
        hoverStyle={{ backgroundColor: C.surface }}
        focusStyle={{ backgroundColor: C.raised }}
      >
        <View pointerEvents="none" accessibilityElementsHidden style={{ width: 16, height: 16 }}>
          <View class="group-hover/sidebar-toggle:opacity-0">
            <Icon name="sidebar" color={C.secondary} />
          </View>
          <View
            class="opacity-0 group-hover/sidebar-toggle:opacity-100"
            style={{ position: 'absolute', left: 0, top: 0 }}
          >
            <Icon
              name={props.browser.expanded ? 'sidebarCollapse' : 'sidebarExpand'}
              color={C.secondary}
            />
          </View>
        </View>
      </Button>
      <Button
        onPress={props.commands}
        accessibilityLabel={tr('Open commands')}
        tooltip={textTooltip(() => tr('Commands · Ctrl+P'))}
        style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
        hoverStyle={{ backgroundColor: C.surface }}
        focusStyle={{ backgroundColor: C.raised }}
        activeStyle={{ backgroundColor: C.line }}
      >
        <Icon name="command" color={C.secondary} />
      </Button>
      <Text numberOfLines={1} style={{ color: C.text, flex: 1, minWidth: 0, fontWeight: '500' }}>
        {props.title}
      </Text>
      <If when={props.files}>
        <Button
          accessibilityLabel={tr('Browse workspace files')}
          tooltip={textTooltip(() => props.workspace || tr('Browse workspace files'))}
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
