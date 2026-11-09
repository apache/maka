/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { Clipboard, cleanup, signal, Text, View, type JSX } from 'nsh';
import { Icon } from './Icon';
import { tr } from './locale';
import { C, textTooltip } from './ui';

export function messageTime(value?: number) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : [date.getHours(), date.getMinutes()].map((part) => String(part).padStart(2, '0')).join(':');
}

export function QuickMessageTools(props: {
  enabled: boolean;
  user?: boolean;
  timestamp?: number;
  children: JSX.Element;
  text(current: () => boolean): string | null | Promise<string | null>;
}) {
  if (!props.enabled) return props.children;
  const hovered = signal(false);
  const focused = signal(false);
  const busy = signal(false);
  const result = signal<'copied' | 'failed' | null>(null);
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => {
    alive = false;
    if (timer !== undefined) clearTimeout(timer);
  });
  const copy = async () => {
    if (busy()) return;
    busy.set(true);
    if (timer !== undefined) clearTimeout(timer);
    result.set(null);
    try {
      const text = await props.text(() => alive);
      if (!alive || text === null) return;
      await Clipboard.writeText(text);
      if (alive) result.set('copied');
    } catch {
      if (alive) result.set('failed');
    } finally {
      if (alive) {
        busy.set(false);
        timer = setTimeout(() => result.set(null), 1400);
      }
    }
  };
  const label = () => (props.user ? tr('Copy user message') : tr('Copy message'));
  return (
    <View
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      style={{ width: '100%' }}
    >
      {props.children}
      <View
        style={{
          height: 22,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          alignSelf: props.user ? 'flex-end' : 'flex-start',
          marginLeft: props.user ? 0 : 32,
          opacity: hovered() || focused() || busy() || result() ? 1 : 0,
        }}
      >
        <Text style={{ color: C.muted, fontSize: 11 }}>{messageTime(props.timestamp)}</Text>
        <View
          role="button"
          focusable
          accessibilityLabel={label()}
          tooltip={textTooltip(label)}
          onFocus={() => focused.set(true)}
          onBlur={() => focused.set(false)}
          onPress={() => void copy()}
          style={{
            height: 22,
            width: 24,
            borderRadius: 4,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          hoverStyle={{ backgroundColor: C.raised }}
          focusStyle={{ backgroundColor: C.raised }}
        >
          <Icon name={result() === 'copied' ? 'check' : 'copy'} size={14} color={C.muted} />
        </View>
        <If when={result()}>
          <Text style={{ color: result() === 'failed' ? C.danger : C.muted, fontSize: 11 }}>
            {result() === 'failed' ? tr('Copy failed') : tr('Copied')}
          </Text>
        </If>
      </View>
    </View>
  );
}
