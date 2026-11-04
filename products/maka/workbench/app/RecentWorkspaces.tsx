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

import { inputAction, Scroll, Text, View, windowSize } from 'nsh';
import { Button, Popover } from 'nsh/base';
import type { BrowserWorkspace } from './browsing';
import { Icon } from './Icon';
import { tr } from './locale';
import { C, controlStyle, controlHoverStyle, controlFocusStyle, textTooltip } from './ui';

export type RecentWorkspace = { workspace: BrowserWorkspace; path: string };
const name = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function RecentWorkspaces(props: {
  path(): string;
  recent(): RecentWorkspace[];
  open(): boolean;
  changed(open: boolean): void;
  choose(workspace: RecentWorkspace): void;
  browse(): void;
  disabled(): boolean;
}) {
  return (
    <Popover
      open={props.open()}
      onOpenChange={({ open }) => props.changed(open)}
      placement="bottom"
      align="center"
      offset={8}
      margin={8}
      popupStyle={{
        width: 360,
        maxWidth: Math.max(0, windowSize().width - 16),
        maxHeight: Math.min(380, windowSize().height - 32),
        padding: 6,
        minHeight: 0,
        backgroundColor: C.surface,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: 12,
      }}
      trigger={
        <Button
          accessibilityLabel={tr('Choose composer workspace')}
          tooltip={textTooltip(() => props.path() || tr('Choose workspace'))}
          disabled={props.disabled()}
          onPress={inputAction(() => props.changed(!props.open()), null)}
          style={{
            ...controlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            maxWidth: '100%',
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Icon name="folder" color={C.secondary} />
          <Text style={[{ fontSize: 13, color: C.secondary, flexShrink: 1 }, { numberOfLines: 1 }]}>
            {props.path() ? name(props.path()) : tr('Choose workspace')}
          </Text>
          <Icon name="down" color={C.secondary} />
        </Button>
      }
    >
      <Text style={{ color: C.muted, fontSize: 12, paddingHorizontal: 10, paddingVertical: 8 }}>
        {tr('Recent folders')}
      </Text>
      <Scroll style={{ flexShrink: 1, minHeight: 0 }}>
        <Each of={props.recent()} key={(item) => item.path}>
          {(item) => (
            <Button
              accessibilityLabel={tr('Use folder {path}', { path: item().path })}
              tooltip={textTooltip(() => item().path)}
              onPress={inputAction(props.choose, item())}
              style={{
                ...controlStyle,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingHorizontal: 10,
              }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
            >
              <Icon name="folder" color={C.secondary} />
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text style={[{ fontSize: 13, color: C.text }, { numberOfLines: 1 }]}>
                  {name(item().path)}
                </Text>
                <Text style={[{ fontSize: 12, color: C.muted }, { numberOfLines: 1 }]}>
                  {item().path}
                </Text>
              </View>
              <If when={item().path === props.path()}>
                <Icon name="check" color={C.accent} />
              </If>
            </Button>
          )}
        </Each>
        <If when={props.recent().length === 0}>
          <Text style={{ fontSize: 13, color: C.muted, padding: 10 }}>
            {tr('No recent folders')}
          </Text>
        </If>
      </Scroll>
      <View style={{ height: 1, backgroundColor: C.line, margin: 4 }} />
      <Button
        accessibilityLabel={tr('Choose another folder…')}
        onPress={inputAction(props.browse, null)}
        style={{
          ...controlStyle,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 10,
        }}
        hoverStyle={controlHoverStyle()}
        focusStyle={controlFocusStyle()}
      >
        <Icon name="folder" color={C.secondary} />
        <Text style={{ fontSize: 13, color: C.text }}>{tr('Choose another folder…')}</Text>
      </Button>
    </Popover>
  );
}
