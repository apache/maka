/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { cleanup, keymap, signal, Text, View, type ViewRef } from 'nsh';
import { qt } from '../../../../plugins/application/quick-tools/shared/i18n';
import { C, IconButton, controlFocusStyle } from './ui';

/** Capture only while this focusable control owns keyboard focus. */
export function QuickShortcutRecorder(props: { value: string; onChange(value: string): void }) {
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
          ref={bind}
          accessibilityLabel={qt('快捷键')}
          onFocus={() => recording.set(true)}
          onBlur={() => recording.set(false)}
          onPress={() => {
            field?.focus();
            recording.set(true);
          }}
          style={{
            flex: 1,
            height: 36,
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
            {props.value
              ? keymap.label(props.value)
              : qt(recording() ? '请按组合键…' : '点击录入快捷键')}
          </Text>
        </View>
        <If when={props.value}>
          <IconButton label={qt('清除快捷键')} icon="close" onPress={() => props.onChange('')} />
        </If>
      </View>
      <If when={recording()}>
        <Text style={{ fontSize: 11, color: C.muted }}>{qt('Esc 结束录入 · Delete 清除')}</Text>
      </If>
    </View>
  );
}
