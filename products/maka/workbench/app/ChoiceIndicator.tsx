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

import { Canvas, Text } from 'nsh';
import { platform } from 'nsh';
import { C, isDark } from './ui';

// Decoration only: the enclosing control keeps its original native action.
export function ChoiceIndicator(props: {
  kind: 'checkbox' | 'radio' | 'switch';
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
}) {
  const width = () => (props.kind === 'switch' ? 32 : 16);
  const color = () =>
    props.disabled ? C.muted : props.checked || props.mixed ? C.accent : C.muted;
  if (platform.idiom === 'terminal')
    return (
      <Text
        accessibilityElementsHidden
        style={[
          {
            width: width(),
            height: 16,
            lineHeight: 16,
            color: props.disabled ? C.muted : props.checked || props.mixed ? C.accentText : C.muted,
            textAlign: 'center',
            flexShrink: 0,
          },
          { pointerEvents: 'none' },
        ]}
      >
        {props.kind === 'checkbox'
          ? props.mixed
            ? '⊟'
            : props.checked
              ? '☑'
              : '☐'
          : props.kind === 'radio'
            ? props.checked
              ? '●'
              : '○'
            : props.checked
              ? '━●'
              : '●━'}
      </Text>
    );
  return (
    <Canvas
      accessibilityElementsHidden
      style={[{ width: width(), height: 16, flexShrink: 0 }, { pointerEvents: 'none' }]}
      draw={(cx) => {
        cx.lineWidth = 1.5;
        cx.lineCap = 'round';
        cx.lineJoin = 'round';
        cx.strokeStyle = color();
        cx.fillStyle = color();
        cx.beginPath();
        if (props.kind === 'switch') {
          cx.roundRect(1, 1, 30, 14, 7);
          cx.fillStyle = props.checked && !props.disabled ? C.accent : C.pressed;
          cx.fill();
          cx.beginPath();
          cx.arc(props.checked ? 24 : 8, 8, 5, 0, Math.PI * 2);
          // A light switch's knob stays white when off, as the system's does; a dark
          // one keeps a light knob on its dark track.
          cx.fillStyle =
            props.checked && !props.disabled ? C.onAccent : isDark() ? C.secondary : C.background;
          cx.fill();
        } else if (props.kind === 'radio') {
          cx.arc(8, 8, 6, 0, Math.PI * 2);
          cx.stroke();
          if (props.checked) {
            cx.beginPath();
            cx.arc(8, 8, 3, 0, Math.PI * 2);
            cx.fill();
          }
        } else {
          cx.roundRect(2, 2, 12, 12, 3);
          if (props.checked || props.mixed) cx.fill();
          else cx.stroke();
          if (props.checked || props.mixed) {
            cx.beginPath();
            cx.strokeStyle = C.onAccent;
            cx.moveTo(4.5, 8);
            if (props.mixed) cx.lineTo(11.5, 8);
            else {
              cx.lineTo(7, 10.5);
              cx.lineTo(11.5, 5.5);
            }
            cx.stroke();
          }
        }
      }}
    />
  );
}
