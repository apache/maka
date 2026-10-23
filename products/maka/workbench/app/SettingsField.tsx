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

import { Input, Text, View } from 'nsh';
import { C, compact, inputBorderRadius, inputTextStyle } from './ui';

export function SettingsField(props: {
  label: string;
  value: string;
  change(value: string): void;
  hint?: string;
  masked?: boolean;
  multiline?: boolean;
  readonly?: boolean;
  disabled?: boolean;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: C.secondary, fontSize: 13, fontWeight: '500' }}>{props.label}</Text>
      <Input
        accessibilityLabel={props.label}
        value={props.value}
        onChange={props.change}
        masked={props.masked}
        multiline={props.multiline}
        readonly={props.readonly || props.disabled}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          height: props.multiline ? (compact() ? 96 : 120) : compact() ? 32 : 40,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: inputBorderRadius,
          backgroundColor: C.background,
          color: props.disabled ? C.muted : C.text,
          paddingHorizontal: 12,
          paddingVertical: compact() ? 4 : 8,
          ...inputTextStyle,
        }}
        focusStyle={{ borderColor: C.accent }}
      />
      <If when={props.hint}>
        <Text style={{ color: C.muted, fontSize: 12, lineHeight: 16 }}>{props.hint}</Text>
      </If>
    </View>
  );
}
