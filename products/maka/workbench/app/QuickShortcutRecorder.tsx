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

import { cleanup, keymap, signal, Text, View, type ViewRef } from 'nsh';
import { qt } from '../../../../plugins/application/quick-tools/shared/i18n';
import { C, IconButton, controlFocusStyle } from './ui';

/** Capture only while this focusable control owns keyboard focus. */
export function QuickShortcutRecorder(props: {
  value: string;
  compact?: boolean;
  onChange(value: string): void;
}) {
  const recording = signal(false);
  let field: ViewRef | undefined;
  let bindings: (() => void)[] = [];
  cleanup(() => bindings.forEach((remove) => remove()));
  const bind = (node: ViewRef) => {
    field = node;
    bindings.forEach((remove) => remove());
    bindings = [];
    const add = (stroke: string, run: () => void) =>
      bindings.push(keymap.bind(stroke, run, { within: node, when: 'always' }));
    const keys = [
      ...'abcdefghijklmnopqrstuvwxyz0123456789',
      'space',
      'enter',
      'tab',
      'up',
      'down',
      'left',
      'right',
      'minus',
      'plus',
      '[',
      ']',
      '\\',
      ';',
      "'",
      ',',
      '.',
      '/',
      '`',
      'backspace',
      'delete',
      'home',
      'end',
      'pageup',
      'pagedown',
      ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`),
    ];
    for (let mask = 1; mask < 16; mask++) {
      if (mask === 8) continue; // Shift alone remains ordinary typing.
      const mods = [
        mask & 1 ? 'ctrl' : '',
        mask & 2 ? 'alt' : '',
        mask & 4 ? 'cmd' : '',
        mask & 8 ? 'shift' : '',
      ].filter(Boolean);
      for (const key of keys) {
        const stroke = [...mods, key].join('+');
        if (['cmd+q', 'cmd+h', 'cmd+m', 'alt+cmd+h', 'ctrl+cmd+f'].includes(stroke)) continue;
        add(stroke, () => props.onChange(stroke));
      }
    }
    for (let i = 1; i <= 20; i++) add(`f${i}`, () => props.onChange(`f${i}`));
    add('escape', () => {
      recording.set(false);
      node.blur();
    });
    add('backspace', () => props.onChange(''));
    add('delete', () => props.onChange(''));
  };
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <View
          role="button"
          focusable
          ref={(node) => {
            field = node;
          }}
          accessibilityLabel={qt('快捷键')}
          onFocus={() => {
            if (field) bind(field);
            recording.set(true);
          }}
          onBlur={() => {
            bindings.splice(0).forEach((remove) => remove());
            recording.set(false);
          }}
          onPress={() => {
            field?.focus();
            recording.set(true);
          }}
          style={{
            flex: 1,
            height: props.compact ? 29 : 36,
            alignItems: props.compact ? 'center' : undefined,
            paddingHorizontal: 10,
            justifyContent: 'center',
            backgroundColor: C.background,
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: 6,
          }}
          focusStyle={controlFocusStyle()}
        >
          <Text style={{ fontSize: 13, color: props.value ? C.text : C.muted }}>
            {props.compact && recording()
              ? qt('请按组合键…')
              : props.value
                ? keymap.label(props.value)
                : qt(recording() ? '请按组合键…' : props.compact ? '未设置' : '点击录入快捷键')}
          </Text>
        </View>
        <If when={props.value && !props.compact}>
          <IconButton label={qt('清除快捷键')} icon="close" onPress={() => props.onChange('')} />
        </If>
      </View>
      <If when={recording() && !props.compact}>
        <Text style={{ fontSize: 11, color: C.muted }}>{qt('Esc 结束录入 · Delete 清除')}</Text>
      </If>
    </View>
  );
}
