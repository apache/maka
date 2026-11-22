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

import { inputAction, List, platform, signal, Text, View, windowSize } from 'nsh';
import { SettingsRow } from './SettingsPage';
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
  controlStyle,
  inputBorderRadius,
  inputTextStyle,
  C,
  floatingStyle,
  menuRowHoverStyle,
} from './ui';

export function RootUiSettings(props: { owner: RootUiSettingsOwner }) {
  const owner = props.owner;
  const open = signal(false);
  const title = () => {
    const choice = owner.current();
    return choice ? rootUiTitle(choice) : tr('Choose interface');
  };
  return (
    <SettingsRow
      label={tr('Interface')}
      description={
        owner.notice() ||
        (owner.pending().length > 0 ? tr('Checking whether the interface changed…') : undefined)
      }
      status={owner.error() || undefined}
      trailing={
        <Popover
          open={open()}
          onOpenChange={({ open: value }) => {
            if (value) owner.query.set('');
            open.set(value);
          }}
          placement="bottom"
          align="start"
          offset={8}
          margin={8}
          popupStyle={{
            ...floatingStyle(),
            width: 420,
            maxHeight: Math.min(360, Math.max(0, windowSize().height - 16)),
            gap: 8,
          }}
          trigger={
            <Button
              accessibilityLabel={tr('Choose interface')}
              disabled={owner.disabled()}
              style={{
                minHeight: platform.idiom === 'terminal' ? 16 : 28,
                paddingLeft: platform.idiom === 'terminal' ? 0 : 10,
                paddingRight: platform.idiom === 'terminal' ? 0 : 6,
                borderRadius: 8,
                backgroundColor: platform.idiom === 'terminal' ? undefined : C.raised,
                flexDirection: 'row',
                gap: 6,
                alignItems: 'center',
              }}
              hoverStyle={{ backgroundColor: C.line }}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, lineHeight: 20, color: C.text }}>{title()}</Text>
              <Icon name="down" color={C.muted} size={14} />
            </Button>
          }
        >
          <If when={open()}>
            <Input
              accessibilityLabel={tr('Search interfaces')}
              autoFocus
              value={owner.query()}
              onChange={({ value }) => owner.query.set(value)}
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
                  selectedStyle={menuRowHoverStyle()}
                  hoverStyle={menuRowHoverStyle()}
                  focusStyle={menuRowHoverStyle()}
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
      }
    />
  );
}
