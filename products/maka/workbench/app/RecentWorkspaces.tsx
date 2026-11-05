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
import type { BrowserWorkspace } from './browsing';
import { Icon } from './Icon';
import { tr } from './locale';
import { C, controlStyle, controlHoverStyle, controlFocusStyle, textTooltip } from './ui';

export type RecentWorkspace = {
  workspace: Extract<BrowserWorkspace, { kind: 'directory' }>;
  path: string;
};
const name = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function RecentWorkspaces(props: {
  path(): string;
  recent(): RecentWorkspace[];
  open(): boolean;
  changed(open: boolean): void;
  choose(workspace: RecentWorkspace): void;
  forget(path: string): void;
  browse(): void;
  disabled(): boolean;
}) {
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
          group: 'recent',
        })),
        {
          value: 'browse',
          title: tr('Choose another folder…'),
          ...(props.recent().length ? { group: 'actions' } : {}),
        },
        ...(props.recent().some((item) => item.path === props.path())
          ? [{ value: 'forget', title: tr('Remove this folder from recents'), group: 'actions' }]
          : []),
      ]}
      onChange={({ value }) => {
        if (value === 'browse') props.browse();
        else if (value === 'forget') props.forget(props.path());
        else {
          const selected = props.recent().find((item) => item.path === value);
          if (selected) props.choose(selected);
        }
      }}
      open={props.open()}
      onOpenChange={({ open }) => props.changed(open)}
      placement="bottom"
      align="center"
      offset={8}
      margin={8}
      popupStyle={{
        width: 392,
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
        <View
          tooltip={textTooltip(() => props.path() || tr('Choose workspace'))}
          style={{
            ...controlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            maxWidth: '100%',
            minWidth: 0,
            flexShrink: 1,
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Icon name="folder" color={C.secondary} />
          <Text
            style={[
              { fontSize: 13, color: C.secondary, flexShrink: 1, textOverflow: 'ellipsis-middle' },
              { numberOfLines: 1 },
            ]}
          >
            {props.path() ? name(props.path()) : tr('Choose workspace')}
          </Text>
          <Icon name="down" color={C.secondary} />
        </View>
      }
      itemStyle={{ padding: 0 }}
      itemClass={`rounded-lg focus:bg-[${C.raised}]`}
      renderGroup={(group) =>
        group.title === 'recent' ? (
          <Text style={{ color: C.muted, fontSize: 12, paddingHorizontal: 10, paddingVertical: 8 }}>
            {tr('Recent folders')}
          </Text>
        ) : (
          <View style={{ height: 1, backgroundColor: C.line, margin: 4 }} />
        )
      }
      renderItem={(item) => (
        <View
          tooltip={item.group === 'recent' ? textTooltip(() => item.value) : undefined}
          style={{
            ...controlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 10,
            paddingHorizontal: 10,
            paddingVertical: 8,
            minHeight: item.group === 'recent' ? 54 : 36,
          }}
        >
          <Icon name={item.value === 'forget' ? 'close' : 'folder'} color={C.secondary} />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={[{ fontSize: 13, color: C.text }, { numberOfLines: 1 }]}>
              {item.group === 'recent' ? name(item.value) : item.title}
            </Text>
            <If when={item.group === 'recent'}>
              <Text
                style={[
                  {
                    fontSize: 12,
                    color: C.muted,
                    width: '100%',
                    textOverflow: 'ellipsis-middle',
                  },
                  { numberOfLines: 1 },
                ]}
              >
                {item.value}
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
