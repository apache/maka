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

import { Text } from 'nsh';
import { MenuItem, MenuSeparator } from 'nsh/base';
import { Icon } from './Icon';
import { tr } from './locale';
import type { SessionActionTarget } from './sessionLifecycle';
import {
  C,
  captionTextStyle,
  controlDisabledStyle,
  menuRowHoverStyle,
  menuRowStyle,
  menuSeparatorStyle,
} from './ui';

export type SessionMenuAction =
  | 'children'
  | 'open_beside'
  | 'rename'
  | 'fork'
  | 'remove'
  | 'compaction_prompt'
  | 'pin'
  | 'unpin'
  | 'archive'
  | 'restore';

export function SessionMenuItems(props: {
  session: SessionActionTarget;
  childrenAvailable?: boolean;
  besideAvailable?: boolean;
  select(action: SessionMenuAction): void;
}) {
  const session = props.session;
  const Item = (item: {
    action: SessionMenuAction;
    label: string;
    text: string;
    icon: Parameters<typeof Icon>[0]['name'];
    disabled?: boolean;
    danger?: boolean;
  }) => (
    <MenuItem
      accessibilityLabel={item.label}
      disabled={item.disabled}
      onSelect={() => props.select(item.action)}
      style={{ ...menuRowStyle(), minWidth: 220 }}
      hoverStyle={menuRowHoverStyle()}
      focusStyle={menuRowHoverStyle()}
      disabledStyle={controlDisabledStyle}
    >
      <Icon name={item.icon} color={item.danger ? C.danger : C.secondary} />
      <Text
        accessibilityElementsHidden
        style={{ ...captionTextStyle, color: item.danger ? C.danger : C.text }}
      >
        {item.text}
      </Text>
    </MenuItem>
  );
  return (
    <>
      <If when={props.childrenAvailable}>
        <Item
          action="children"
          label={tr('Child conversations')}
          text={tr('Child conversations')}
          icon="children"
        />
      </If>
      <If when={props.besideAvailable}>
        <Item
          action="open_beside"
          label={tr('Open to the side')}
          text={tr('Open to the side')}
          icon="split"
        />
      </If>
      <If when={props.childrenAvailable || props.besideAvailable}>
        <MenuSeparator style={menuSeparatorStyle()} />
      </If>
      <Item
        action={session.pinned ? 'unpin' : 'pin'}
        label={session.pinned ? tr('Unpin conversation') : tr('Pin conversation')}
        text={session.pinned ? tr('Unpin') : tr('Pin')}
        icon="pin"
        disabled={session.archived}
      />
      <Item
        action="rename"
        label={tr('Rename conversation')}
        text={tr('Rename…')}
        icon="edit"
        disabled={session.archived}
      />
      <Item
        action={session.archived ? 'restore' : 'archive'}
        label={session.archived ? tr('Restore conversation') : tr('Archive conversation')}
        text={session.archived ? tr('Restore') : tr('Archive')}
        icon={session.archived ? 'latest' : 'archive'}
      />
      <MenuSeparator style={menuSeparatorStyle()} />
      <Item action="fork" label={tr('Fork conversation')} text={tr('Fork…')} icon="fork" />
      <Item
        action="compaction_prompt"
        label={tr('Edit conversation compaction prompt')}
        text={tr('Compaction prompt…')}
        icon="compaction"
        disabled={session.archived}
      />
      <MenuSeparator style={menuSeparatorStyle()} />
      <Item
        action="remove"
        label={tr('Delete conversation')}
        text={tr('Delete…')}
        icon="trash"
        danger
      />
    </>
  );
}
