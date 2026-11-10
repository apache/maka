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

import { Canvas, Path2D, Text, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import { C, bodyTextStyle, controlFocusStyle, controlHoverStyle } from './ui';

/** The height controls in the bar center on, however tall its input grows. */
export const QUICK_BAR_SLOT = 40;

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

/** A launcher row; without an icon its title lines up with the input's text. */
export function QuickRow(props: {
  label: string;
  title: string;
  hint?: string;
  icon?: JSX.Element;
  selected: boolean;
  onPress(): void;
}) {
  return (
    <Button
      accessibilityLabel={props.label}
      selected={props.selected}
      onPress={props.onPress}
      style={props.icon ? quickRowStyle : { ...quickRowStyle, paddingLeft: 42 }}
      selectedStyle={{ backgroundColor: C.raised }}
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
    >
      {props.icon}
      <Text
        style={{
          ...bodyTextStyle,
          flex: 1,
          minWidth: 0,
          fontWeight: '500',
          color: C.text,
          numberOfLines: 1,
          textOverflow: 'ellipsis',
        }}
      >
        {props.title}
      </Text>
      <If when={props.hint !== undefined}>
        <Text style={{ fontSize: 12, lineHeight: 18, flexShrink: 0, color: C.muted }}>
          {props.hint}
        </Text>
      </If>
    </Button>
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
