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
import test from 'node:test';
import { diagramSvg } from '../app/mermaid.ts';

const dark = {
  background: '#161719',
  text: '#f0f1f3',
  muted: '#969ba4',
  secondary: '#c6c9ce',
  surface: '#202123',
  raised: '#2a2b2e',
  line: '#37393e',
  accent: '#8ab8f8',
  danger: '#f48a8a',
};
const light = { ...dark, background: '#ffffff', text: '#1c1d1f', surface: '#f5f5f6' };

test('Pele SVG attributes get concrete workbench theme colors', () => {
  for (const source of [
    'flowchart LR\n A[用户] --> B[Maka]',
    'sequenceDiagram\n User->>Maka: 画图\n Maka-->>User: 完成',
    'classDiagram\n class Agent\n Agent : +run()',
    'erDiagram\n SESSION ||--o{ EVENT : contains',
    'pie title Tokens\n "Input" : 70\n "Output" : 30',
  ]) {
    const { svg } = diagramSvg(source, dark, 720);
    assert.doesNotMatch(svg, /var\(/);
    assert.match(svg, /#f0f1f3/);
  }
  const source = 'flowchart LR\n A[开始] --> B[结束]';
  const night = diagramSvg(source, dark, 720).svg;
  const day = diagramSvg(source, light, 720).svg;
  assert.match(night, /开始/);
  assert.match(day, /#1c1d1f/);
  assert.notEqual(night, day);
});

test('theme resolution preserves literal labels, explicit styles and disables diagram links', () => {
  const { svg } = diagramSvg(
    'flowchart LR\n A["var(--pele-fg)"] --> B["&lt;script&gt;"]\n style B fill:#123456\n click A "https://example.com"',
    dark,
    720,
  );
  assert.match(svg, />var\(--pele-fg\)<\//);
  assert.match(svg, /fill:#123456/);
  assert.doesNotMatch(svg, /<script|<a\b|href=/);
});
