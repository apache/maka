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

import { Canvas, View } from 'nsh';
import type { ComposerContextUsage } from '../../../../packages/plugin-sdk/src/composer-view.js';
import { tr } from './locale';
import { C, textTooltip } from './ui';

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function contextUsageText(usage: ComposerContextUsage): string {
  const share = usage.tokens / usage.window;
  const percent = share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`;
  const tokens = `${usage.approximate ? '≈' : ''}${compact(usage.tokens)}`;
  return `${tr('Context')} ${tokens} / ${compact(usage.window)} · ${percent}`;
}

// A ring for how much of the model's context the conversation uses; the
// numbers are in its tooltip. It turns to warning from 70% and danger from 90%.
export function ContextGauge(props: { usage: () => ComposerContextUsage }) {
  const share = () => Math.min(1, props.usage().tokens / props.usage().window);
  const color = () => (share() >= 0.9 ? C.danger : share() >= 0.7 ? C.warning : C.muted);
  return (
    <View
      role="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: share() * 100 }}
      accessibilityLabel={contextUsageText(props.usage())}
      tooltip={textTooltip(() => contextUsageText(props.usage()))}
      style={{
        width: 24,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Canvas
        accessibilityElementsHidden
        style={[{ width: 16, height: 16 }, { pointerEvents: 'none' }]}
        draw={(cx) => {
          cx.lineWidth = 1.5;
          cx.lineCap = 'round';
          cx.strokeStyle = C.line;
          cx.beginPath();
          cx.arc(8, 8, 6.25, 0, Math.PI * 2);
          cx.stroke();
          // A small share still shows as a short arc.
          const start = -Math.PI / 2;
          cx.strokeStyle = color();
          cx.beginPath();
          cx.arc(8, 8, 6.25, start, start + Math.max(0.04, share()) * Math.PI * 2);
          cx.stroke();
        }}
      />
    </View>
  );
}
