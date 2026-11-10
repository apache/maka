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

import { textTooltip } from './ui';
import { inputAction, Scroll, signal, Text, View } from 'nsh';
import { Button, Popover } from 'nsh/base';
import { windowSize } from 'nsh';
import type {
  AgentSession,
  AgentWorkspaceAccess,
} from '../../../../packages/plugin-sdk/src/index.js';
import type {
  ComposerPermissions as SessionPermissions,
  PendingComposerPermissions,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import { ChoiceIndicator } from './ChoiceIndicator';
import { delayed } from './delayed';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  C,
  captionTextStyle,
  controlDisabledStyle,
  floatingStyle,
  menuDetailTextStyle,
  menuLabelStyle,
  menuRowHoverStyle,
  menuRowStyle,
  menuSeparatorStyle,
  toolbarControlStyle,
} from './ui';

const accessChoices: AgentWorkspaceAccess[] = [
  'read_only',
  'workspace_write',
  'danger_full_access',
];
const accessLabel = (access: AgentWorkspaceAccess) =>
  ({
    read_only: tr('Read only'),
    workspace_write: tr('Workspace write'),
    danger_full_access: tr('Full access'),
  })[access];
const accessDetail = (access: AgentWorkspaceAccess) =>
  ({
    read_only: tr('Read files without changing the workspace.'),
    workspace_write: tr('Read and write within the workspace.'),
    danger_full_access: tr('No sandbox; reads and writes any file.'),
  })[access];
const accessIcon = {
  read_only: 'readOnly',
  workspace_write: 'workspaceWrite',
  danger_full_access: 'sandboxOff',
} as const satisfies Record<AgentWorkspaceAccess, string>;

type MenuSnapshot = {
  session: AgentSession | null;
  permissions: { access: AgentWorkspaceAccess | null; requestPermissions: boolean | null };
};
type PermissionChange =
  | { kind: 'access'; value: AgentWorkspaceAccess }
  | { kind: 'requests'; value: boolean };
type MenuOwner = {
  pending(): boolean;
  error(): string;
  snapshot(): MenuSnapshot | null;
  select(input: { snapshot: MenuSnapshot; change: PermissionChange }): void;
};

export function SessionPermissionsSelect(props: {
  owner: SessionPermissions | null;
  pending?: PendingComposerPermissions | null;
}) {
  return (
    <View style={{ minWidth: 0, flexShrink: 1 }}>
      <If when={props.owner === null && !props.pending}>
        <Button
          disabled
          accessibilityLabel={tr('Sandbox and approvals')}
          tooltip={textTooltip(() => tr('Choose a conversation to change sandbox settings.'))}
          style={toolbarControlStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Sandbox')}</Text>
        </Button>
      </If>
      <Each<SessionPermissions>
        of={props.owner ? [props.owner] : []}
        key={(owner: SessionPermissions) => owner.sessionId}
      >
        {(item) => {
          const owner = item();
          const menu: MenuOwner = {
            pending: owner.pending,
            error: owner.error,
            snapshot: () => {
              const session = owner.snapshot();
              return session ? { session, permissions: session.permissions } : null;
            },
            select: ({ snapshot, change }) => {
              const session = snapshot.session;
              if (!session) return;
              const settings =
                change.kind === 'access'
                  ? { ...session.permissions, access: change.value }
                  : { ...session.permissions, requestPermissions: change.value };
              void owner.select({ session, settings });
            },
          };
          return <PermissionsMenu owner={menu} />;
        }}
      </Each>
      <Each<PendingComposerPermissions>
        of={props.pending ? [props.pending] : []}
        key={(owner) => owner.id}
      >
        {(item) => {
          const owner = item();
          const menu: MenuOwner = {
            pending: owner.pending,
            error: () => '',
            snapshot: () => ({
              session: null,
              permissions: {
                access: owner.access(),
                requestPermissions: owner.requestPermissions(),
              },
            }),
            select: ({ snapshot, change }) => {
              if (
                snapshot.permissions.access !== owner.access() ||
                snapshot.permissions.requestPermissions !== owner.requestPermissions()
              )
                return;
              if (change.kind === 'access') owner.selectAccess(change.value);
              else owner.selectRequests(change.value);
            },
          };
          return <PermissionsMenu owner={menu} />;
        }}
      </Each>
    </View>
  );
}

function PermissionsMenu(props: { owner: MenuOwner }) {
  const owner = props.owner;
  const open = signal(false);
  // A save that settles quickly keeps the menu as it is. Choices made while
  // it is pending are ignored by `select`, so only the look waits.
  const saving = delayed(owner.pending);
  const disabled = () => saving() || owner.snapshot() === null;
  const asking = () => owner.snapshot()?.permissions.requestPermissions === true;
  const changeOpen = (next: boolean) => {
    if (!owner.pending()) open.set(next);
  };
  const label = () => {
    const access = owner.snapshot()?.permissions.access;
    return access === 'danger_full_access'
      ? tr('Sandbox off')
      : access
        ? accessLabel(access)
        : tr('Sandbox');
  };
  return (
    <Popover
      open={open()}
      onOpenChange={({ open }) => changeOpen(open)}
      closeOnEscape={!owner.pending()}
      closeOnPressOutside={!owner.pending()}
      placement="top"
      align="start"
      offset={8}
      margin={8}
      style={{ minWidth: 0, flexShrink: 1 }}
      popupStyle={{
        ...floatingStyle(),
        width: 340,
        maxHeight: Math.max(0, windowSize().height - 16),
      }}
      trigger={
        <Button
          disabled={disabled()}
          accessibilityLabel={tr('Sandbox and approvals')}
          // The open menu names itself; its trigger's tooltip would cover the menu.
          tooltip={textTooltip(() =>
            open()
              ? undefined
              : owner.snapshot()
                ? tr('Sandbox and approvals')
                : tr('Loading sandbox settings…'),
          )}
          style={{
            ...toolbarControlStyle,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
          }}
          hoverStyle={{ backgroundColor: C.line }}
          focusStyle={{ backgroundColor: C.line }}
          disabledStyle={controlDisabledStyle}
        >
          <Text
            style={[
              { ...captionTextStyle, color: C.secondary, flexShrink: 1 },
              { numberOfLines: 1 },
            ]}
          >
            {label()}
          </Text>
          <Icon name="down" color={C.muted} />
        </Button>
      }
    >
      <If when={owner.snapshot() !== null}>
        <Scroll style={{ minHeight: 0, flexShrink: 1 }}>
          <View>
            <Text style={menuLabelStyle()}>{tr('Sandbox')}</Text>
            <Each<AgentWorkspaceAccess>
              of={accessChoices}
              key={(access: AgentWorkspaceAccess) => access}
            >
              {(access) => {
                const checked = () => owner.snapshot()?.permissions.access === access();
                const tone = () => (access() === 'danger_full_access' ? C.warning : undefined);
                return (
                  <Button
                    disabled={disabled()}
                    selected={checked()}
                    accessibilityLabel={
                      access() === 'danger_full_access'
                        ? tr('Full access · Sandbox off')
                        : accessLabel(access())
                    }
                    onPress={inputAction(owner.select, {
                      snapshot: owner.snapshot()!,
                      change: { kind: 'access', value: access() },
                    })}
                    style={menuRowStyle()}
                    hoverStyle={menuRowHoverStyle()}
                    focusStyle={menuRowHoverStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Icon name={accessIcon[access()]} color={tone() ?? C.secondary} />
                    <View style={[{ flex: 1, minWidth: 0, gap: 2 }, { pointerEvents: 'none' }]}>
                      <Text style={{ ...captionTextStyle, color: C.text }}>
                        {accessLabel(access())}
                      </Text>
                      <Text style={{ ...menuDetailTextStyle, color: tone() ?? C.muted }}>
                        {accessDetail(access())}
                      </Text>
                    </View>
                    <View style={{ width: 16 }}>
                      <If when={checked()}>
                        <Icon name="check" color={C.accent} />
                      </If>
                    </View>
                  </Button>
                );
              }}
            </Each>
            <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
            <Button
              disabled={disabled()}
              selected={asking()}
              accessibilityLabel={tr('{label}: {state}', {
                label: tr('Ask for approval'),
                state: asking() ? tr('On') : tr('Off'),
              })}
              onPress={inputAction(owner.select, {
                snapshot: owner.snapshot()!,
                change: { kind: 'requests', value: !asking() },
              })}
              style={menuRowStyle()}
              hoverStyle={menuRowHoverStyle()}
              focusStyle={menuRowHoverStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="approval" color={C.secondary} />
              <View style={[{ flex: 1, minWidth: 0, gap: 2 }, { pointerEvents: 'none' }]}>
                <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Ask for approval')}</Text>
                <Text style={{ ...menuDetailTextStyle, color: C.muted }}>
                  {tr('When off, anything outside the sandbox is blocked.')}
                </Text>
              </View>
              <ChoiceIndicator kind="switch" checked={asking()} disabled={disabled()} />
            </Button>
            <Text style={noteStyle()}>
              {tr('Applies to this conversation; changing it clears earlier approvals.')}
            </Text>
            <If when={saving()}>
              <Text style={noteStyle()}>{tr('Saving sandbox settings…')}</Text>
            </If>
            <If when={owner.error()}>
              <Text style={[{ ...noteStyle(), color: C.danger }, { userSelect: 'text' }]}>
                {owner.error()}
              </Text>
            </If>
          </View>
        </Scroll>
      </If>
    </Popover>
  );
}

const noteStyle = () => ({
  ...menuDetailTextStyle,
  color: C.muted,
  paddingHorizontal: 8,
  paddingTop: 4,
  paddingBottom: 8,
});
