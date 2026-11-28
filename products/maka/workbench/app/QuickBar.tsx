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

import { Canvas, Image, Path2D, signal, type InputRef, Text, View, type JSX } from 'nsh';
import { Button, Input } from 'nsh/base';
import type { QuickIcon } from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { Icon } from './Icon';
import { bodyTextStyle, C, controlFocusStyle, controlHoverStyle, lineWidth, radius } from './ui';

/** The height controls in the bar center on, however tall its input grows. */
export const QUICK_BAR_SLOT = 40;
/** Fixed, so the launcher can place the selection without measuring rows. */
export const QUICK_ROW_HEIGHT = 40;
export const QUICK_SECTION_HEIGHT = 28;

export const quickBarStyle = {
  flexDirection: 'row',
  alignItems: 'flex-start',
  gap: 10,
  minHeight: 60,
  paddingVertical: 10,
  paddingLeft: 16,
  paddingRight: 12,
} as const;

export const quickRowStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
  paddingVertical: 10,
  paddingHorizontal: 16,
} as const;

export function QuickSectionTitle(props: { title: string }) {
  return (
    <Text
      style={{
        height: QUICK_SECTION_HEIGHT,
        lineHeight: QUICK_SECTION_HEIGHT,
        paddingHorizontal: 16,
        fontSize: 12,
        color: C.muted,
      }}
    >
      {props.title}
    </Text>
  );
}

export function QuickRow(props: {
  label: string;
  title: string;
  pluginName?: string | undefined;
  detail?: string | undefined;
  trailing?: string | undefined;
  /** What to type for the row, such as a command's alias, shown before `trailing`. */
  badge?: string | undefined;
  icon: QuickIcon | 'maka';
  image?: string | undefined;
  previewRow?: boolean;
  unread: boolean;
  selected: boolean;
  onPress(): void;
}) {
  return (
    <Button
      accessibilityLabel={props.label}
      selected={props.selected}
      onPress={props.onPress}
      style={[quickRowStyle, { height: QUICK_ROW_HEIGHT, paddingVertical: 0 }]}
      selectedStyle={{ backgroundColor: C.raised }}
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
    >
      <If
        when={props.image !== undefined}
        else={
          <If
            when={props.icon === 'maka'}
            else={<Icon name={props.icon as QuickIcon} color={C.secondary} size={16} />}
          >
            <MakaMark />
          </If>
        }
      >
        <Image
          src={props.image!}
          style={[
            { width: 20, height: 20, marginHorizontal: -2, flexShrink: 0 },
            { objectFit: 'contain' },
          ]}
        />
      </If>
      <Text
        style={{
          ...bodyTextStyle,
          flexShrink: 1,
          minWidth: 0,
          maxWidth: props.pluginName ? '50%' : props.previewRow ? '86%' : '60%',
          fontWeight: '500',
          color: props.previewRow && props.selected ? C.accentText : C.text,
          numberOfLines: 1,
          textOverflow: 'ellipsis',
        }}
      >
        {props.title}
      </Text>
      <If when={!!props.pluginName}>
        <Text
          style={{
            fontSize: 12,
            lineHeight: 18,
            color: C.muted,
            maxWidth: '24%',
            flexShrink: 1,
            minWidth: 0,
            numberOfLines: 1,
            textOverflow: 'ellipsis',
          }}
        >
          {props.pluginName}
        </Text>
      </If>
      <Text
        style={{
          ...bodyTextStyle,
          flex: 1,
          minWidth: 0,
          color: C.muted,
          numberOfLines: 1,
          textOverflow: 'ellipsis',
        }}
      >
        {props.detail ?? ''}
      </Text>
      <If when={props.unread}>
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            flexShrink: 0,
            backgroundColor: C.accent,
          }}
        />
      </If>
      <If when={props.badge !== undefined}>
        <Text
          style={{
            fontSize: 12,
            lineHeight: 18,
            flexShrink: 0,
            paddingHorizontal: 6,
            borderRadius: radius(4),
            borderWidth: lineWidth(),
            borderColor: C.line,
            color: C.secondary,
          }}
        >
          {props.badge}
        </Text>
      </If>
      <If when={props.trailing !== undefined}>
        <Text style={{ fontSize: 12, lineHeight: 18, flexShrink: 0, color: C.muted }}>
          {props.trailing}
        </Text>
      </If>
    </Button>
  );
}

export function QuickFooter(props: {
  action: string;
  title: string;
  menu: JSX.Element;
  menuOpen?: boolean;
  onAction?: (() => void) | undefined;
}) {
  // Read when drawn: the theme can change while the launcher is open.
  const hint = () => ({ fontSize: 12, lineHeight: 18, color: C.muted });
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 16,
        height: 32,
        paddingLeft: 16,
        paddingRight: props.menuOpen ? 0 : 16,
        borderTopWidth: 1,
        borderTopColor: C.line,
      }}
    >
      <Text style={{ ...hint(), flex: 1, minWidth: 0, numberOfLines: 1, textOverflow: 'ellipsis' }}>
        {props.title}
      </Text>
      <If when={props.onAction} else={<Text style={hint()}>{`${props.action} ↵`}</Text>}>
        <Button
          accessibilityLabel={props.action}
          onPress={() => props.onAction?.()}
          style={{ paddingHorizontal: 8, height: 26, justifyContent: 'center' }}
        >
          <Text style={{ ...hint(), color: C.secondary }}>{`${props.action} ↵`}</Text>
        </Button>
      </If>
      {props.menu}
    </View>
  );
}

export const quickInputStyle = () =>
  ({
    fontSize: 16,
    lineHeight: 24,
    padding: 0,
    color: C.text,
    placeholderColor: C.muted,
    backgroundColor: 'transparent',
  }) as const;

const mark = new Path2D('M6.1 1.3h3.8 M1.35 14.35 8 3.55l6.65 10.8 M4.95 8.5 8 13.6l3.05-5.1');

export function MakaMark(props: { size?: number }) {
  const size = () => props.size ?? 16;
  return (
    <Canvas
      accessibilityElementsHidden
      style={[{ width: size(), height: size(), flexShrink: 0 }, { pointerEvents: 'none' }]}
      draw={(context) => {
        context.scale(size() / 16, size() / 16);
        context.strokeStyle = '#47A3E2';
        context.lineWidth = 1.45;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.stroke(mark);
      }}
    />
  );
}

/** Size short launcher chats to their rows. Long histories keep their virtual scrolling window. */
export function compactTranscriptSize() {
  const measured = signal<ReadonlyMap<string, number>>(new Map());
  return {
    height(count: number, keyAt: (index: number) => string) {
      if (!count) return 0;
      if (count > 16) return 400;
      let height = 32; // The list has 16 pt of padding at each end.
      for (let index = 0; index < count; index++) {
        height += measured().get(keyAt(index)) ?? 96;
      }
      return Math.min(height, 400);
    },
    measure(key: string, height: number) {
      const current = measured();
      if (current.get(key) === height) return;
      const next = new Map(current);
      next.delete(key);
      next.set(key, height);
      if (next.size > 32) next.delete(next.keys().next().value!);
      measured.set(next);
    },
  };
}

/** Shared input and trailing actions for a conversation inside the launcher. */
export function CompactInputBar(props: {
  attach?(node: InputRef): void;
  label: string;
  placeholder: string;
  value: string;
  readonly?: boolean;
  change(value: string): void;
  submit(): void;
  extra?: JSX.Element;
  actions: JSX.Element;
}) {
  const height = signal<number>(quickInputStyle().lineHeight);
  return (
    <View style={quickBarStyle}>
      <View style={{ height: QUICK_BAR_SLOT, justifyContent: 'center' }}>
        <MakaMark />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 8, paddingVertical: 8 }}>
        <Input
          ref={props.attach}
          autoFocus
          multiline
          submitBehavior="submit"
          accessibilityLabel={props.label}
          placeholder={props.placeholder}
          value={props.value}
          readonly={props.readonly ?? false}
          onChange={({ value }) => props.change(value)}
          onSubmit={props.submit}
          onContentSizeChange={({ size }) => height.set(Math.min(size.height, 96))}
          style={{ ...quickInputStyle(), height: height() }}
        />
        {props.extra}
      </View>
      <View style={{ height: QUICK_BAR_SLOT, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        {props.actions}
      </View>
    </View>
  );
}
