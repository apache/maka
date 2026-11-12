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

import { Canvas, Image, keymap, Path2D, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { QuickIcon } from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { Icon } from './Icon';
import { tr } from './locale';
import { C, bodyTextStyle, controlFocusStyle, controlHoverStyle } from './ui';

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
          flexShrink: 0,
          maxWidth: props.previewRow ? '86%' : '60%',
          fontWeight: '500',
          color: props.previewRow && props.selected ? C.accent : C.text,
          numberOfLines: 1,
          textOverflow: 'ellipsis',
        }}
      >
        {props.title}
      </Text>
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
            borderRadius: 4,
            borderWidth: 1,
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
  settings: boolean;
  onAction?: (() => void) | undefined;
}) {
  const hint = { fontSize: 12, lineHeight: 18, color: C.muted } as const;
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 16,
        height: 32,
        paddingHorizontal: 16,
        borderTopWidth: 1,
        borderTopColor: C.line,
      }}
    >
      <If when={props.settings}>
        <Text style={hint}>{`${tr('Settings')} ${keymap.label('mod+,')}`}</Text>
      </If>
      <If when={props.onAction} else={<Text style={hint}>{`${props.action} ↵`}</Text>}>
        <Button
          accessibilityLabel={props.action}
          onPress={() => props.onAction?.()}
          style={{ paddingHorizontal: 8, height: 26, justifyContent: 'center' }}
        >
          <Text style={{ ...hint, color: C.accent }}>{`${props.action} ↵`}</Text>
        </Button>
      </If>
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

export function MakaMark() {
  return (
    <Canvas
      accessibilityElementsHidden
      style={[{ width: 16, height: 16, flexShrink: 0 }, { pointerEvents: 'none' }]}
      draw={(context) => {
        context.strokeStyle = '#47A3E2';
        context.lineWidth = 1.45;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.stroke(mark);
      }}
    />
  );
}
