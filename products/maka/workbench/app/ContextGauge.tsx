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

import { Canvas, signal, Text, View } from 'nsh';
import { Button, Popover } from 'nsh/base';
import type { ComposerContextUsage } from '../../../../packages/plugin-sdk/src/composer-view.js';
import { composerToolbar } from './composerToolbar';
import { tr } from './locale';
import {
  C,
  captionTextStyle,
  floatingStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from './ui';
import { formatCompactCount, formatDecimal } from './numberFormat';
import { TokenCount } from './TokenCount';

// A ring for how much of the model's context the conversation uses; the
// numbers are in its tooltip and popover. Visibility follows Settings › General › Composer.
export function ContextGauge(props: { usage: () => ComposerContextUsage }) {
  const open = signal(false);
  const prefix = () => (props.usage().approximate ? '≈' : '');
  const percent = () => {
    const share = props.usage().tokens / props.usage().window;
    return share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`;
  };
  const speed = () => {
    const speed = props.usage().outputTokensPerSecond;
    return speed === null ? '' : tr('{speed} tok/s', { speed: formatDecimal(speed, 1, 1) });
  };
  const summary = () =>
    [
      `${tr('Context')} ${prefix()}${formatCompactCount(props.usage().tokens)} / ${formatCompactCount(props.usage().window)}`,
      percent(),
      speed(),
    ]
      .filter(Boolean)
      .join(' · ');
  const share = () => Math.min(1, props.usage().tokens / props.usage().window);
  const visible = () => {
    const mode = composerToolbar.contextUsage();
    return mode === 'always' || (mode === 'high' && share() >= 0.7);
  };
  const color = () => (share() >= 0.9 ? C.danger : share() >= 0.7 ? C.warning : C.muted);
  return (
    <If when={visible()}>
      <Popover
        open={open()}
        onOpenChange={({ open: next }) => open.set(next)}
        closeOnEscape
        closeOnPressOutside
        placement="top"
        align="end"
        offset={8}
        popupStyle={{ ...floatingStyle(), padding: 12 }}
        trigger={
          <Button
            accessibilityLabel={summary()}
            tooltip={textTooltip(() => (open() ? undefined : summary()))}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
            style={{
              width: 24,
              height: 28,
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            <Canvas
              accessibilityElementsHidden
              style={[{ width: 14, height: 14 }, { pointerEvents: 'none' }]}
              draw={(cx) => {
                cx.lineWidth = 1.5;
                cx.lineCap = 'round';
                cx.strokeStyle = C.line;
                cx.beginPath();
                cx.arc(7, 7, 5.5, 0, Math.PI * 2);
                cx.stroke();
                // A small share still shows as a short arc.
                const start = -Math.PI / 2;
                cx.strokeStyle = color();
                cx.beginPath();
                cx.arc(7, 7, 5.5, start, start + Math.max(0.04, share()) * Math.PI * 2);
                cx.stroke();
              }}
            />
          </Button>
        }
      >
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Context')}</Text>
          <TokenCount
            label={tr('Context used (tokens)')}
            prefix={prefix()}
            value={props.usage().tokens}
            style={captionTextStyle}
          />
          <Text style={{ ...captionTextStyle, color: C.muted }}>/</Text>
          <TokenCount
            label={tr('Context window (tokens)')}
            value={props.usage().window}
            style={captionTextStyle}
          />
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {[percent(), speed()].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </Popover>
    </If>
  );
}
