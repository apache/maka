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

import { inputAction, List, signal, Text, View, windowSize } from 'nsh';
import { Button, Input, Popover } from 'nsh/base';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import { tr } from './locale';
import { rootUiTitle, type RootUiSettingsOwner } from './rootUiSettingsState';
import {
  bodyTextStyle,
  captionTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  inputBorderRadius,
  inputTextStyle,
  C,
} from './ui';

export function RootUiSettings(props: { owner: RootUiSettingsOwner }) {
  const owner = props.owner;
  const open = signal(false);
  const title = () => {
    const choice = owner.current();
    return choice ? rootUiTitle(choice) : tr('Choose interface');
  };
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ ...bodyTextStyle, fontWeight: '600', color: C.text }}>{tr('Interface')}</Text>
      <If when={owner.error()}>
        <Text style={[{ ...captionTextStyle, color: C.danger }, { userSelect: 'text' }]}>
          {owner.error()}
        </Text>
      </If>
      <If when={owner.notice()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{owner.notice()}</Text>
      </If>
      <If when={!owner.pendingKnown() || owner.pending().length > 0}>
        <Button
          accessibilityLabel={tr('Check interface changes')}
          disabled={owner.busy()}
          onPress={owner.recover}
          style={{ ...controlStyle, alignSelf: 'flex-start' }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.warning }}>
            {tr('Check interface changes')}
          </Text>
        </Button>
        <Each of={owner.pending().filter((item) => !item.reference)} key={(item) => item.id}>
          {(original) => (
            <Button
              accessibilityLabel={tr('Abandon unconfirmed interface change')}
              disabled={owner.busy()}
              onPress={inputAction(owner.abandon, original().id)}
              style={{ ...controlStyle, alignSelf: 'flex-start' }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.warning }}>
                {tr('Abandon unconfirmed interface change')}
              </Text>
            </Button>
          )}
        </Each>
      </If>
      <Popover
        open={open()}
        onOpenChange={(value) => open.set(value)}
        placement="bottom"
        align="start"
        offset={8}
        margin={8}
        popupStyle={{
          width: 420,
          maxWidth: Math.max(0, windowSize().width - 16),
          maxHeight: Math.min(360, Math.max(0, windowSize().height - 16)),
          minHeight: 0,
          padding: 8,
          gap: 8,
          backgroundColor: C.surface,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 12,
        }}
        trigger={
          <Button
            accessibilityLabel={tr('Choose interface')}
            disabled={owner.disabled()}
            onPress={() => {
              if (!owner.disabled()) {
                owner.query.set('');
                open.set(!open());
              }
            }}
            style={{
              ...controlStyle,
              minHeight: 40,
              flexDirection: 'row',
              gap: 8,
              alignItems: 'center',
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...bodyTextStyle, color: C.text, flex: 1 }}>{title()}</Text>
            <Icon name="down" color={C.secondary} />
          </Button>
        }
      >
        <If when={open()}>
          <Input
            accessibilityLabel={tr('Search interfaces')}
            autoFocus
            value={owner.query()}
            onChange={(value) => owner.query.set(value)}
            placeholder={tr('Search interfaces…')}
            style={{
              ...inputTextStyle,
              color: C.text,
              placeholderColor: C.muted,
              backgroundColor: C.background,
              height: 40,
              paddingHorizontal: 12,
              borderRadius: inputBorderRadius,
            }}
          />
          <List
            each={owner.filtered()}
            keyExtractor={(choice) => choice.key}
            estimatedItemSize={56}
            style={{
              height: Math.max(1, owner.filtered().length) * 56,
              minHeight: 0,
              flexShrink: 1,
            }}
            empty={
              <Text style={{ ...bodyTextStyle, color: C.muted }}>
                {tr('No matching interfaces.')}
              </Text>
            }
          >
            {(choice) => (
              <Button
                accessibilityLabel={tr('Use interface {name}', { name: rootUiTitle(choice()) })}
                selected={owner.selected(choice())}
                disabled={owner.disabled()}
                onPress={inputAction((request) => {
                  open.set(false);
                  return owner.choose(request);
                }, owner.action(choice()))}
                style={{
                  ...controlStyle,
                  height: 56,
                  flexDirection: 'row',
                  gap: 8,
                  alignItems: 'center',
                }}
                selectedStyle={{ backgroundColor: C.raised }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <ChoiceIndicator
                  kind="radio"
                  checked={owner.selected(choice())}
                  disabled={owner.disabled()}
                />
                <View style={{ flex: 1, minWidth: 0, gap: 4, pointerEvents: 'none' }}>
                  <Text style={{ ...bodyTextStyle, color: C.text }}>{rootUiTitle(choice())}</Text>
                  <Text style={{ ...captionTextStyle, color: C.muted }}>
                    {choice().instance.package.id}
                  </Text>
                </View>
              </Button>
            )}
          </List>
        </If>
      </Popover>
    </View>
  );
}
