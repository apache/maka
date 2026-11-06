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
import { Text, View, type ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { C, bodyTextStyle, captionTextStyle, controlStyle, controlDisabledStyle } from './ui';
import { Icon } from './Icon';
import { LoadingIndicator } from './Loading';
import { tr } from './locale';

/** Setup actions share the workbench's control geometry and an inset keyboard focus ring. */
export function PermissionButton(props: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress(): void;
  buttonRef?: (node: ViewRef) => void;
}) {
  return (
    <Button
      ref={props.buttonRef}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        ...controlStyle,
        borderWidth: 1,
        borderColor: C.line,
        backgroundColor: props.primary ? C.accent : C.surface,
      }}
      hoverStyle={{ backgroundColor: props.primary ? C.accentHover : C.raised }}
      activeStyle={{ backgroundColor: props.primary ? C.accentHover : C.raised, opacity: 0.8 }}
      focusStyle={{
        outlineStyle: 'solid',
        outlineWidth: 2,
        outlineOffset: -2,
        outlineColor: C.accent,
        borderColor: props.primary ? C.text : C.accent,
      }}
      disabledStyle={controlDisabledStyle}
    >
      <Text
        style={{
          ...bodyTextStyle,
          color: props.primary ? C.background : C.text,
          fontWeight: props.primary ? '600' : '400',
        }}
      >
        {props.label}
      </Text>
    </Button>
  );
}

/** One stable status lane: a check is always paired with text, never color alone. */
export function PermissionRow(props: {
  name: string;
  purpose: string;
  index: number;
  ready: boolean;
  active: boolean;
  busy: boolean;
}) {
  return (
    <View class="flex-row gap-3 py-4" style={{ borderBottomWidth: 1, borderBottomColor: C.line }}>
      <View
        class="size-8 items-center justify-center rounded-lg"
        style={{ backgroundColor: props.ready ? C.added : C.surface }}
        accessibilityElementsHidden
      >
        <If
          when={props.ready}
          else={<Text style={{ ...bodyTextStyle, color: C.secondary }}>{props.index + 1}</Text>}
        >
          <Icon name="check" color={C.success} />
        </If>
      </View>
      <View class="flex-1 min-w-0 gap-1">
        <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>{props.name}</Text>
        <Text style={{ ...captionTextStyle, color: C.secondary }}>{props.purpose}</Text>
        <View class="flex-row items-center gap-2 pt-1">
          <If when={props.busy}>
            <LoadingIndicator />
          </If>
          <Text style={{ ...captionTextStyle, color: props.ready ? C.success : C.muted }}>
            {props.ready
              ? tr('permissionSetup.ready')
              : props.busy
                ? tr('permissionSetup.waitingForMac')
                : props.active
                  ? tr('permissionSetup.notEnabled')
                  : tr('permissionSetup.next')}
          </Text>
        </View>
      </View>
    </View>
  );
}
