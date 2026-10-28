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
import type { AgentWorkspaceAccess } from '../../../../packages/plugin-sdk/src/index.js';
import type { ComposerPermissions as SessionPermissions } from '../../../../packages/plugin-sdk/src/composer-view.js';
import { ChoiceIndicator } from './ChoiceIndicator';
import { delayed } from './delayed';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  C,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
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
    danger_full_access: tr('Sandbox off'),
  })[access];

export function SessionPermissionsSelect(props: { owner: SessionPermissions | null }) {
  return (
    <View style={{ minWidth: 0, flexShrink: 1 }}>
      <If when={props.owner === null}>
        <Button
          disabled
          accessibilityLabel={tr('Sandbox and approvals')}
          tooltip={textTooltip(() => tr('Choose a conversation to change sandbox settings.'))}
          style={controlStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Sandbox')}</Text>
        </Button>
      </If>
      <Each<SessionPermissions>
        of={props.owner ? [props.owner] : []}
        key={(owner: SessionPermissions) => owner.sessionId}
      >
        {(owner) => <PermissionsMenu owner={owner()} />}
      </Each>
    </View>
  );
}

function PermissionsMenu(props: { owner: SessionPermissions }) {
  const owner = props.owner;
  const open = signal(false);
  // A save that settles quickly keeps the menu as it is. Choices made while
  // it is pending are ignored by `select`, so only the look waits.
  const saving = delayed(owner.pending);
  const disabled = () => saving() || owner.snapshot() === null;
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
        width: 340,
        maxWidth: Math.max(0, windowSize().width - 16),
        maxHeight: Math.max(0, windowSize().height - 16),
        minHeight: 0,
        padding: 8,
        backgroundColor: C.surface,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: 12,
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
          onPress={inputAction(changeOpen, !open())}
          style={{
            ...controlStyle,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text
            style={[{ ...captionTextStyle, color: C.muted, flexShrink: 1 }, { numberOfLines: 1 }]}
          >
            {label()}
          </Text>
          <Icon name="down" color={C.muted} />
        </Button>
      }
    >
      <If when={owner.snapshot() !== null}>
        <View style={{ minHeight: 0, flexShrink: 1, gap: 4 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <Text style={{ ...captionTextStyle, color: C.secondary, paddingHorizontal: 8 }}>
              {tr('Sandbox and approvals')}
            </Text>
            <Button
              disabled={saving()}
              accessibilityLabel={tr('Close sandbox settings')}
              tooltip={textTooltip(() => tr('Close'))}
              onPress={inputAction(changeOpen, false)}
              style={{ ...controlStyle, width: 32, alignItems: 'center' }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="close" color={C.muted} />
            </Button>
          </View>
          <Scroll style={{ minHeight: 0, flexShrink: 1 }}>
            <View style={{ gap: 4 }}>
              <Each<AgentWorkspaceAccess>
                of={accessChoices}
                key={(access: AgentWorkspaceAccess) => access}
              >
                {(access) => (
                  <Button
                    disabled={disabled()}
                    selected={owner.snapshot()?.permissions.access === access()}
                    accessibilityLabel={
                      access() === 'danger_full_access'
                        ? tr('Full access · Sandbox off')
                        : accessLabel(access())
                    }
                    onPress={inputAction(owner.select, {
                      session: owner.snapshot()!,
                      settings: { ...owner.snapshot()!.permissions, access: access() },
                    })}
                    style={rowStyle()}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <ChoiceIndicator
                      kind="radio"
                      checked={owner.snapshot()?.permissions.access === access()}
                      disabled={disabled()}
                    />
                    <View style={[{ flex: 1, minWidth: 0 }, { pointerEvents: 'none' }]}>
                      <Text style={{ ...captionTextStyle, color: C.text }}>
                        {accessLabel(access())}
                      </Text>
                      <Text style={{ ...captionTextStyle, color: C.muted }}>
                        {accessDetail(access())}
                      </Text>
                    </View>
                  </Button>
                )}
              </Each>
              <View
                style={[
                  { height: 1, backgroundColor: C.line, margin: 4 },
                  { pointerEvents: 'none' },
                ]}
              />
              <Text
                style={{
                  ...captionTextStyle,
                  color: C.secondary,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                }}
              >
                {tr('Approval requests')}
              </Text>
              <Each<boolean> of={[true, false]} key={(ask: boolean) => ask}>
                {(ask) => (
                  <Button
                    disabled={disabled()}
                    selected={owner.snapshot()?.permissions.requestPermissions === ask()}
                    accessibilityLabel={
                      ask() ? tr('Ask for approval') : tr('Do not ask for approval')
                    }
                    onPress={inputAction(owner.select, {
                      session: owner.snapshot()!,
                      settings: { ...owner.snapshot()!.permissions, requestPermissions: ask() },
                    })}
                    style={rowStyle()}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <ChoiceIndicator
                      kind="radio"
                      checked={owner.snapshot()?.permissions.requestPermissions === ask()}
                      disabled={disabled()}
                    />
                    <Text style={{ ...captionTextStyle, color: C.text, flex: 1, minWidth: 0 }}>
                      {ask() ? tr('Ask for approval') : tr('Do not ask for approval')}
                    </Text>
                  </Button>
                )}
              </Each>
              <Text style={{ ...captionTextStyle, color: C.muted, paddingHorizontal: 8 }}>
                {tr('Tools outside this policy are blocked when approval requests are off.')}
              </Text>
              <Text style={{ ...captionTextStyle, color: C.muted, padding: 8 }}>
                {tr(
                  'Applies to this conversation. Changing either setting clears earlier approvals.',
                )}
              </Text>
              <If when={saving()}>
                <Text style={{ ...captionTextStyle, color: C.muted, padding: 8 }}>
                  {tr('Saving sandbox settings…')}
                </Text>
              </If>
              <If when={owner.error()}>
                <Text
                  style={[
                    { ...captionTextStyle, color: C.danger, padding: 8 },
                    { userSelect: 'text' },
                  ]}
                >
                  {owner.error()}
                </Text>
              </If>
            </View>
          </Scroll>
        </View>
      </If>
    </Popover>
  );
}

const rowStyle = () => ({
  ...controlStyle,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 12,
});
