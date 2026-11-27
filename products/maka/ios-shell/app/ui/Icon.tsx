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

import { Canvas, Path2D, Text, View, platform, token, type CanvasRenderingContext2D } from 'nsh';

type Shape =
  | { tag: 'path' | 'filledPath'; d: string }
  | { tag: 'circle'; cx: number; cy: number; r: number }
  | { tag: 'rect'; x: number; y: number; width: number; height: number; rx?: number }
  | { tag: 'line'; x1: number; y1: number; x2: number; y2: number };

const glyphs = {
  maka: [
    { tag: 'rect', x: 3.5, y: 3.5, width: 17, height: 17, rx: 4.5 },
    { tag: 'path', d: 'M8 15.5V8.5l4 4.5 4-4.5v7' },
  ],
  laptop: [
    { tag: 'rect', x: 3.5, y: 4.5, width: 17, height: 11.5, rx: 2 },
    { tag: 'path', d: 'M2 19h20' },
  ],
  qr: [
    { tag: 'rect', x: 3, y: 3, width: 6.5, height: 6.5, rx: 1.5 },
    { tag: 'rect', x: 14.5, y: 3, width: 6.5, height: 6.5, rx: 1.5 },
    { tag: 'rect', x: 3, y: 14.5, width: 6.5, height: 6.5, rx: 1.5 },
    { tag: 'path', d: 'M14.5 14.5h2.5v2.5h-2.5z' },
    { tag: 'path', d: 'M18.5 18.5H21v2.5h-2.5' },
    { tag: 'path', d: 'M14.5 20.5h2' },
    { tag: 'path', d: 'M20.5 14.5v2' },
  ],
  link: [
    { tag: 'path', d: 'M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.5 1.5' },
    { tag: 'path', d: 'M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.5-1.5' },
  ],
  camera: [
    {
      tag: 'path',
      d: 'M4 8.5A2 2 0 0 1 6 6.5h2.2l1.3-2h5l1.3 2H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
    },
    { tag: 'circle', cx: 12, cy: 13, r: 3.2 },
  ],
  torch: [
    { tag: 'path', d: 'M9 3h6l1 4-2 2.5V20a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V9.5L8 7z' },
    { tag: 'line', x1: 9.5, y1: 6.5, x2: 14.5, y2: 6.5 },
  ],
  shield: [
    { tag: 'path', d: 'M12 3 5 6v6c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6z' },
    { tag: 'path', d: 'm9.2 12 2 2 3.8-4' },
  ],
  more: [
    { tag: 'circle', cx: 5, cy: 12, r: 1 },
    { tag: 'circle', cx: 12, cy: 12, r: 1 },
    { tag: 'circle', cx: 19, cy: 12, r: 1 },
  ],
  chevronRight: [{ tag: 'path', d: 'm9.5 6.5 5.5 5.5-5.5 5.5' }],
  chevronLeft: [{ tag: 'path', d: 'm14.5 6.5-5.5 5.5 5.5 5.5' }],
  chevronDown: [{ tag: 'path', d: 'm6.5 9.5 5.5 5.5 5.5-5.5' }],
  plus: [
    { tag: 'line', x1: 12, y1: 5, x2: 12, y2: 19 },
    { tag: 'line', x1: 5, y1: 12, x2: 19, y2: 12 },
  ],
  close: [
    { tag: 'line', x1: 6.5, y1: 6.5, x2: 17.5, y2: 17.5 },
    { tag: 'line', x1: 17.5, y1: 6.5, x2: 6.5, y2: 17.5 },
  ],
  search: [
    { tag: 'circle', cx: 11, cy: 11, r: 6.5 },
    { tag: 'line', x1: 16, y1: 16, x2: 20.5, y2: 20.5 },
  ],
  check: [{ tag: 'path', d: 'm5.5 12.5 4.2 4.2 8.8-9.2' }],
  xCircle: [
    { tag: 'circle', cx: 12, cy: 12, r: 9 },
    { tag: 'path', d: 'm9 9 6 6m0-6-6 6' },
  ],
  checkCircle: [
    { tag: 'circle', cx: 12, cy: 12, r: 9 },
    { tag: 'path', d: 'm8.5 12.3 2.4 2.4 4.8-5.2' },
  ],
  chat: [{ tag: 'path', d: 'M20 12a7.5 7.5 0 0 1-7.5 7.5H5l1.8-3A7.5 7.5 0 1 1 20 12z' }],
  inbox: [
    { tag: 'rect', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 },
    { tag: 'path', d: 'M3.5 13h4.5l1.5 2.5h5L16 13h4.5' },
  ],
  globe: [
    { tag: 'circle', cx: 12, cy: 12, r: 9 },
    { tag: 'path', d: 'M3.5 12h17' },
    {
      tag: 'path',
      d: 'M12 3a13.5 13.5 0 0 1 3.8 9 13.5 13.5 0 0 1-3.8 9 13.5 13.5 0 0 1-3.8-9A13.5 13.5 0 0 1 12 3z',
    },
  ],
  appearance: [
    { tag: 'circle', cx: 12, cy: 12, r: 9 },
    { tag: 'path', d: 'M12 3v18' },
    { tag: 'path', d: 'M12 7.5h4.5' },
    { tag: 'path', d: 'M12 12h6' },
    { tag: 'path', d: 'M12 16.5h4.5' },
  ],
  sliders: [
    { tag: 'line', x1: 4, y1: 7, x2: 20, y2: 7 },
    { tag: 'circle', cx: 9, cy: 7, r: 2 },
    { tag: 'line', x1: 4, y1: 12, x2: 20, y2: 12 },
    { tag: 'circle', cx: 15, cy: 12, r: 2 },
    { tag: 'line', x1: 4, y1: 17, x2: 20, y2: 17 },
    { tag: 'circle', cx: 10, cy: 17, r: 2 },
  ],
  sparkles: [{ tag: 'path', d: 'M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2 5.5-2z' }],
  users: [
    { tag: 'circle', cx: 9.5, cy: 8.5, r: 3.2 },
    { tag: 'path', d: 'M3.5 19.5a6 6 0 0 1 12 0' },
    { tag: 'circle', cx: 16.5, cy: 9.5, r: 2.3 },
    { tag: 'path', d: 'M16.5 14.5a4.5 4.5 0 0 1 4 4.5' },
  ],
  puzzle: [
    {
      tag: 'path',
      d: 'M8 4.5h3a2 2 0 1 1 4 0h3a1.5 1.5 0 0 1 1.5 1.5v3a2 2 0 1 1 0 4v3a1.5 1.5 0 0 1-1.5 1.5h-10a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 8 4.5z',
    },
  ],
  plug: [
    { tag: 'path', d: 'M9 3v5' },
    { tag: 'path', d: 'M15 3v5' },
    { tag: 'path', d: 'M6.5 8h11v3a5.5 5.5 0 0 1-11 0z' },
    { tag: 'path', d: 'M12 16.5V21' },
  ],
  book: [
    { tag: 'path', d: 'M4.5 5.5A2.5 2.5 0 0 1 7 3h12.5v16.5H7a2.5 2.5 0 0 0-2.5 2.5z' },
    { tag: 'path', d: 'M4.5 19.5A2.5 2.5 0 0 1 7 17h12.5' },
  ],
  network: [
    { tag: 'path', d: 'M5 9.5a10 10 0 0 1 14 0' },
    { tag: 'path', d: 'M8 13a6 6 0 0 1 8 0' },
    { tag: 'circle', cx: 12, cy: 17, r: 1.2 },
  ],
  warning: [
    { tag: 'path', d: 'M12 3.8 20.5 19H3.5z' },
    { tag: 'line', x1: 12, y1: 9.5, x2: 12, y2: 13.8 },
    { tag: 'circle', cx: 12, cy: 16.5, r: 0.7 },
  ],
  copy: [
    { tag: 'rect', x: 9, y: 9, width: 11, height: 11, rx: 2 },
    { tag: 'path', d: 'M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5' },
  ],
  refresh: [
    { tag: 'path', d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' },
    { tag: 'path', d: 'M19.5 4.5v4h-4' },
  ],
  trash: [
    { tag: 'path', d: 'M4.5 7h15' },
    { tag: 'path', d: 'M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2' },
    { tag: 'path', d: 'M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5l1-12' },
  ],
  haptics: [
    { tag: 'rect', x: 7.5, y: 4, width: 9, height: 16, rx: 2 },
    { tag: 'path', d: 'M4 8.5v7' },
    { tag: 'path', d: 'M20 8.5v7' },
  ],
  clipboard: [
    { tag: 'rect', x: 5, y: 5, width: 14, height: 16, rx: 2 },
    { tag: 'rect', x: 9, y: 3, width: 6, height: 3.5, rx: 1 },
  ],
  terminal: [
    { tag: 'rect', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 },
    { tag: 'path', d: 'm7.5 10 3 2.5-3 2.5' },
    { tag: 'line', x1: 12.5, y1: 15, x2: 16.5, y2: 15 },
  ],
  help: [
    { tag: 'circle', cx: 12, cy: 12, r: 9 },
    { tag: 'path', d: 'M9.5 9.5a2.6 2.6 0 0 1 5 1c0 1.6-2.5 2-2.5 3.5' },
    { tag: 'circle', cx: 12, cy: 17, r: 0.7 },
  ],
  compose: [
    { tag: 'path', d: 'M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6' },
    { tag: 'path', d: 'M18.5 3.5a2.1 2.1 0 0 1 3 3L12 16l-4 1 1-4z' },
  ],
  send: [
    { tag: 'line', x1: 12, y1: 18, x2: 12, y2: 6 },
    { tag: 'path', d: 'm7 11 5-5 5 5' },
  ],
  stop: [{ tag: 'filledPath', d: 'M4 4h16v16H4z' }],
  play: [{ tag: 'filledPath', d: 'M6 3 21 12 6 21z' }],
  folder: [
    {
      tag: 'path',
      d: 'M3.5 7A2 2 0 0 1 5.5 5H9l2 2.5h7.5a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
    },
  ],
  file: [
    {
      tag: 'path',
      d: 'M6.5 3.5h7.5l4.5 4.5V19a1.5 1.5 0 0 1-1.5 1.5h-10.5A1.5 1.5 0 0 1 5 19V5A1.5 1.5 0 0 1 6.5 3.5z',
    },
    { tag: 'path', d: 'M14 3.5V8h4.5' },
  ],
  diff: [
    { tag: 'path', d: 'M12 4.5v9' },
    { tag: 'path', d: 'M7.5 9h9' },
    { tag: 'path', d: 'M7.5 18.5h9' },
  ],
  queue: [
    { tag: 'line', x1: 4.5, y1: 7, x2: 19.5, y2: 7 },
    { tag: 'line', x1: 4.5, y1: 12, x2: 15, y2: 12 },
    { tag: 'line', x1: 4.5, y1: 17, x2: 12, y2: 17 },
  ],
  sideQuestion: [
    { tag: 'path', d: 'M4 5v6a4 4 0 0 0 4 4h5' },
    {
      tag: 'path',
      d: 'M20 10h-5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h1v3l4-3a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2z',
    },
  ],
  quote: [
    { tag: 'path', d: 'M6 9h4v4H7.5c0 1.5.8 2.5 2 3' },
    { tag: 'path', d: 'M14 9h4v4h-2.5c0 1.5.8 2.5 2 3' },
  ],
  arrowDown: [
    { tag: 'line', x1: 12, y1: 6, x2: 12, y2: 18 },
    { tag: 'path', d: 'm7 13 5 5 5-5' },
  ],
  pin: [{ tag: 'path', d: 'm15 4.5 4.5 4.5-3.5 3.5 1 4-4.5-4.5-5 5-1-1 5-5L7 6.5l4 1z' }],
  keyboardDown: [
    { tag: 'rect', x: 3.5, y: 5, width: 17, height: 10, rx: 2 },
    { tag: 'path', d: 'm9.5 18.5 2.5 2.5 2.5-2.5' },
  ],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof glyphs;

const pathCache = new Map<string, Path2D>();
for (const shapes of Object.values(glyphs)) {
  for (const s of shapes) {
    if ((s.tag === 'path' || s.tag === 'filledPath') && !pathCache.has(s.d)) {
      pathCache.set(s.d, new Path2D(s.d));
    }
  }
}

function drawShape(cx: CanvasRenderingContext2D, shape: Shape) {
  switch (shape.tag) {
    case 'filledPath':
      cx.fill(pathCache.get(shape.d)!);
      return;
    case 'path':
      cx.stroke(pathCache.get(shape.d)!);
      return;
    case 'circle':
      cx.beginPath();
      cx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
      cx.stroke();
      return;
    case 'rect':
      cx.beginPath();
      cx.roundRect(shape.x, shape.y, shape.width, shape.height, shape.rx ?? 0);
      cx.stroke();
      return;
    case 'line':
      cx.beginPath();
      cx.moveTo(shape.x1, shape.y1);
      cx.lineTo(shape.x2, shape.y2);
      cx.stroke();
      return;
  }
}

export function Icon(props: {
  name: IconName;
  color: string;
  size?: number;
  strokeWidth?: number;
}) {
  const size = () => props.size ?? 20;
  if (platform.idiom === 'terminal') {
    return (
      <Text accessibilityElementsHidden style={{ color: props.color, fontSize: size() }}>
        •
      </Text>
    );
  }
  return (
    <Canvas
      accessibilityElementsHidden
      style={{ width: size(), height: size(), flexShrink: 0, pointerEvents: 'none' }}
      draw={(cx) => {
        const scale = size() / 24;
        cx.scale(scale, scale);
        cx.fillStyle = props.color;
        cx.strokeStyle = props.color;
        cx.lineWidth = props.strokeWidth ?? 1.9;
        cx.lineCap = 'round';
        cx.lineJoin = 'round';
        for (const shape of glyphs[props.name]) {
          drawShape(cx, shape);
        }
      }}
    />
  );
}

/** Apple Settings-style rounded-square SF icon badge (28x28 continuous corner). */
export function IconBadge(props: {
  name: IconName;
  background: string;
  color?: string;
  size?: number;
  iconSize?: number;
  radius?: number;
}) {
  const box = () => props.size ?? 28;
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: box(),
        height: box(),
        borderRadius: props.radius ?? 7,
        borderCurve: 'continuous',
        backgroundColor: props.background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon
        name={props.name}
        color={props.color ?? token('primary-foreground')}
        size={props.iconSize ?? 16}
      />
    </View>
  );
}
