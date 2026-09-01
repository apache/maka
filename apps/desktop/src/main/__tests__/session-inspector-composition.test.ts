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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InspectorCompositionSection } from '../../renderer/features/workbar/testing.js';
import { getDesktopConversationCopy } from '../../renderer/locales/conversation-copy.js';

test('maps each request-composition category to the same colour in the chart and legend', () => {
  const markup = renderToStaticMarkup(
    createElement(InspectorCompositionSection, {
      copy: getDesktopConversationCopy('en').inspector,
      state: {
        status: 'available',
        composition: {
          parts: [
            { kind: 'system_instructions', estimatedTokens: 10 },
            { kind: 'tool_definitions', estimatedTokens: 20 },
            { kind: 'messages', estimatedTokens: 30 },
            { kind: 'other', estimatedTokens: 40 },
          ],
          tools: [],
        },
      },
      formatNumber: (value: number) => String(value),
    }),
  );

  for (const [kind, tokens] of [
    ['system_instructions', 10],
    ['tool_definitions', 20],
    ['messages', 30],
    ['other', 40],
  ] as const) {
    assert.match(
      markup,
      new RegExp(`class="maka-inspector-composition-band"[^>]*data-segment="${kind}"[^>]*flex-grow:${tokens}`),
    );
    assert.match(
      markup,
      new RegExp(`class="maka-inspector-composition-swatch"[^>]*data-segment="${kind}"`),
    );
  }
});
