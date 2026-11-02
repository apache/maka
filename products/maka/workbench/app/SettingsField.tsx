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

import { Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { windowSize } from 'nsh';
import { C, compact, inputBorderRadius, inputTextStyle } from './ui';

type SettingsInputProps = {
  label: string;
  value: string;
  change(value: string): void;
  readonly?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
};

const inputStyle = (disabled?: boolean) => ({
  borderWidth: 1,
  borderColor: C.line,
  borderRadius: inputBorderRadius,
  backgroundColor: C.background,
  color: disabled ? C.muted : C.text,
  paddingHorizontal: 12,
  paddingVertical: 4,
  ...inputTextStyle,
});

export function SettingsEditor(props: SettingsInputProps) {
  return (
    <Input
      accessibilityLabel={props.label}
      autoFocus={props.autoFocus}
      value={props.value}
      placeholder={props.placeholder}
      onChange={({ value }) => props.change(value)}
      multiline
      submitBehavior="newline"
      readonly={props.readonly || props.disabled}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        ...inputStyle(props.disabled),
        flex: 1,
        minHeight: inputTextStyle.lineHeight + 2 * (compact() ? 4 : 8) + 2,
      }}
      focusStyle={{ borderColor: C.accent }}
    />
  );
}

export function SettingsField(
  props: SettingsInputProps & {
    hint?: string;
    masked?: boolean;
    multiline?: boolean;
    error?: string;
  },
) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: C.secondary, fontSize: 13, fontWeight: '500' }}>{props.label}</Text>
      <Input
        accessibilityLabel={props.label}
        autoFocus={props.autoFocus}
        value={props.value}
        placeholder={props.placeholder}
        onChange={({ value }) => props.change(value)}
        masked={props.masked}
        multiline={props.multiline}
        readonly={props.readonly || props.disabled}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          ...inputStyle(props.disabled),
          ...(props.error ? { borderColor: C.danger } : {}),
          placeholderColor: C.muted,
          height: props.multiline ? undefined : 32,
          minHeight: props.multiline && !compact() ? 96 : 32,
          maxHeight: props.multiline ? windowSize().height / 2 : undefined,
        }}
        focusStyle={{ borderColor: C.accent }}
      />
      <If when={props.error}>
        <Text style={{ color: C.danger, fontSize: 12, lineHeight: 16 }}>{props.error}</Text>
      </If>
      <If when={props.hint}>
        <Text style={{ color: C.muted, fontSize: 12, lineHeight: 16 }}>{props.hint}</Text>
      </If>
    </View>
  );
}
