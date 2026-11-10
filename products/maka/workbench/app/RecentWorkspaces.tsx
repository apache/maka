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

import { Text, View, windowSize } from 'nsh';
import { Select } from 'nsh/base';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  C,
  captionTextStyle,
  floatingStyle,
  menuRowStyle,
  menuSeparatorStyle,
  textTooltip,
  toolbarControlStyle,
} from './ui';

export type RecentWorkspace = { path: string };
const parts = (path: string) => path.split(/[\\/]/).filter(Boolean);
const name = (path: string) => parts(path).at(-1) ?? path;

export function RecentWorkspaces(props: {
  path(): string;
  recent(): RecentWorkspace[];
  open(): boolean;
  changed(open: boolean): void;
  choose(workspace: RecentWorkspace): void;
  browse(): void;
  disabled(): boolean;
}) {
  // Folders that share a name also show their parent's.
  const parent = (path: string) =>
    props.recent().filter((item) => name(item.path) === name(path)).length > 1
      ? (parts(path).at(-2) ?? '')
      : '';
  return (
    <Select
      style={{ minWidth: 0, flexShrink: 1 }}
      accessibilityLabel={tr('Choose composer workspace')}
      disabled={props.disabled()}
      value={props.path() || null}
      items={[
        ...props.recent().map((item) => ({
          value: item.path,
          title: tr('Use folder {path}', { path: item.path }),
        })),
        {
          value: 'browse',
          title: tr('Choose another folder…'),
          ...(props.recent().length ? { group: 'actions' } : {}),
        },
      ]}
      onChange={({ value }) => {
        if (value === 'browse') props.browse();
        else {
          const selected = props.recent().find((item) => item.path === value);
          if (selected) props.choose(selected);
        }
      }}
      open={props.open()}
      onOpenChange={({ open }) => props.changed(open)}
      placement="top"
      align="start"
      offset={8}
      margin={8}
      popupStyle={{
        ...floatingStyle(),
        width: 260,
        maxHeight: Math.min(380, windowSize().height - 32),
      }}
      trigger={
        <View
          tooltip={textTooltip(() => props.path() || tr('Choose workspace'))}
          style={{
            ...toolbarControlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            maxWidth: '100%',
            minWidth: 0,
            flexShrink: 1,
          }}
          hoverStyle={{ backgroundColor: C.line }}
          focusStyle={{ backgroundColor: C.line }}
        >
          <Icon name="folder" color={C.muted} />
          <Text
            style={[
              {
                ...captionTextStyle,
                color: C.secondary,
                flexShrink: 1,
                textOverflow: 'ellipsis-middle',
              },
              { numberOfLines: 1 },
            ]}
          >
            {props.path() ? name(props.path()) : tr('Choose workspace')}
          </Text>
          <Icon name="down" color={C.muted} />
        </View>
      }
      itemStyle={{ padding: 0 }}
      itemClass={`rounded-lg focus:bg-[${C.floatingRaised}]`}
      renderGroup={() => <View style={menuSeparatorStyle()} />}
      renderItem={(item) => (
        <View
          tooltip={item.value === 'browse' ? undefined : textTooltip(() => item.value)}
          style={menuRowStyle()}
        >
          <Icon name={item.value === 'browse' ? 'plus' : 'folder'} color={C.secondary} />
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', gap: 8 }}>
            <Text
              style={[{ ...captionTextStyle, color: C.text, flexShrink: 1 }, { numberOfLines: 1 }]}
            >
              {item.value === 'browse' ? item.title : name(item.value)}
            </Text>
            <If when={item.value !== 'browse' && parent(item.value)}>
              <Text
                style={[
                  { ...captionTextStyle, color: C.muted, flexShrink: 1 },
                  { numberOfLines: 1 },
                ]}
              >
                {parent(item.value)}
              </Text>
            </If>
          </View>
          <View style={{ width: 16 }}>
            <If when={item.value === props.path()}>
              <Icon name="check" color={C.accent} />
            </If>
          </View>
        </View>
      )}
    />
  );
}
