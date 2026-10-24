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
import { platform } from 'nsh/device';

const glyphs = {
  back: '‹',
  sidebar: '◫',
  sidebarCollapse: '◁',
  sidebarExpand: '▷',
  plus: '+',
  send: '↑',
  stop: '■',
  close: '×',
  down: '⌄',
  right: '›',
  search: '⌕',
  settings: '⚙',
  folder: '📁',
  refresh: '↻',
  file: '📄',
  terminal: '⌁',
  command: '⌘',
  copy: '⧉',
  archive: '▤',
  trash: '⌫',
  wrap: '↵',
  nowrap: '→',
  code: '⌘',
  check: '✓',
  more: '⋯',
  latest: '↓',
  paperclip: '📎',
  queue: '≡',
  edit: '✎',
  image: '▧',
  expand: '⛶',
  fork: '⑂',
  shield: '◇',
  lock: '▣',
  activity: '◌',
  unread: '●',
};

export function Icon(props: { name: keyof typeof glyphs; color: string }) {
  if (platform.isTerminal)
    return (
      <Text
        selectable={false}
        pointerEvents="none"
        accessibilityElementsHidden
        style={{
          width: 16,
          height: 16,
          lineHeight: 16,
          color: props.color,
          textAlign: 'center',
          flexShrink: 0,
        }}
      >
        {glyphs[props.name]}
      </Text>
    );
  return (
    <Canvas
      pointerEvents="none"
      accessibilityElementsHidden
      style={{ width: 16, height: 16, flexShrink: 0 }}
      draw={(cx) => {
        cx.strokeStyle = props.color;
        cx.fillStyle = props.color;
        cx.lineWidth = 1.5;
        cx.lineCap = 'round';
        cx.lineJoin = 'round';
        cx.beginPath();
        switch (props.name) {
          case 'sidebar':
          case 'sidebarCollapse':
          case 'sidebarExpand':
            cx.roundRect(1.5, 1.5, 13, 13, 2);
            cx.moveTo(5.5, 1.5);
            cx.lineTo(5.5, 14.5);
            if (props.name === 'sidebarCollapse') {
              cx.moveTo(10.5, 5.5);
              cx.lineTo(8, 8);
              cx.lineTo(10.5, 10.5);
            } else if (props.name === 'sidebarExpand') {
              cx.moveTo(8.5, 5.5);
              cx.lineTo(11, 8);
              cx.lineTo(8.5, 10.5);
            }
            break;
          case 'plus':
            cx.moveTo(8, 3);
            cx.lineTo(8, 13);
            cx.moveTo(3, 8);
            cx.lineTo(13, 8);
            break;
          case 'send':
            cx.moveTo(8, 13);
            cx.lineTo(8, 3);
            cx.moveTo(3.5, 7.5);
            cx.lineTo(8, 3);
            cx.lineTo(12.5, 7.5);
            break;
          case 'stop':
            cx.roundRect(4, 4, 8, 8, 1);
            cx.fill();
            return;
          case 'close':
            cx.moveTo(4, 4);
            cx.lineTo(12, 12);
            cx.moveTo(12, 4);
            cx.lineTo(4, 12);
            break;
          case 'expand':
            cx.moveTo(6, 2);
            cx.lineTo(2, 2);
            cx.lineTo(2, 6);
            cx.moveTo(10, 2);
            cx.lineTo(14, 2);
            cx.lineTo(14, 6);
            cx.moveTo(2, 10);
            cx.lineTo(2, 14);
            cx.lineTo(6, 14);
            cx.moveTo(10, 14);
            cx.lineTo(14, 14);
            cx.lineTo(14, 10);
            break;
          case 'down':
            cx.moveTo(4, 6);
            cx.lineTo(8, 10);
            cx.lineTo(12, 6);
            break;
          case 'back':
            cx.moveTo(10, 4);
            cx.lineTo(6, 8);
            cx.lineTo(10, 12);
            break;
          case 'right':
            cx.moveTo(6, 4);
            cx.lineTo(10, 8);
            cx.lineTo(6, 12);
            break;
          case 'search':
            cx.arc(7, 7, 4.5, 0, Math.PI * 2);
            cx.moveTo(10.5, 10.5);
            cx.lineTo(14, 14);
            break;
          case 'settings':
            cx.arc(8, 8, 5, 0, Math.PI * 2);
            cx.moveTo(10, 8);
            cx.arc(8, 8, 2, 0, Math.PI * 2);
            for (let i = 0; i < 8; i++) {
              const angle = (i * Math.PI) / 4;
              cx.moveTo(8 + Math.cos(angle) * 5, 8 + Math.sin(angle) * 5);
              cx.lineTo(8 + Math.cos(angle) * 7, 8 + Math.sin(angle) * 7);
            }
            break;
          case 'folder':
            cx.moveTo(1.5, 5);
            cx.lineTo(1.5, 3);
            cx.lineTo(6, 3);
            cx.lineTo(8, 5);
            cx.lineTo(14.5, 5);
            cx.lineTo(14.5, 13);
            cx.lineTo(1.5, 13);
            cx.closePath();
            break;
          case 'refresh':
            cx.arc(8, 8, 5, -0.7, Math.PI * 1.7);
            cx.moveTo(12, 1.5);
            cx.lineTo(12.5, 5);
            cx.lineTo(9, 4.5);
            break;
          case 'file':
            cx.moveTo(3, 1.5);
            cx.lineTo(9, 1.5);
            cx.lineTo(13, 5.5);
            cx.lineTo(13, 14.5);
            cx.lineTo(3, 14.5);
            cx.closePath();
            cx.moveTo(9, 1.5);
            cx.lineTo(9, 5.5);
            cx.lineTo(13, 5.5);
            break;
          case 'command':
            cx.moveTo(5.5, 3.5);
            cx.arc(3.5, 3.5, 2, 0, Math.PI / 2, true);
            cx.lineTo(12.5, 5.5);
            cx.arc(12.5, 3.5, 2, Math.PI / 2, Math.PI, true);
            cx.lineTo(10.5, 12.5);
            cx.arc(12.5, 12.5, 2, Math.PI, (Math.PI * 3) / 2, true);
            cx.lineTo(3.5, 10.5);
            cx.arc(3.5, 12.5, 2, (Math.PI * 3) / 2, Math.PI * 2, true);
            cx.lineTo(5.5, 3.5);
            break;
          case 'terminal':
            cx.roundRect(1, 2, 14, 12, 2);
            cx.moveTo(4, 5);
            cx.lineTo(7, 8);
            cx.lineTo(4, 11);
            cx.moveTo(9, 11);
            cx.lineTo(12, 11);
            break;
          case 'edit':
            cx.moveTo(3, 10);
            cx.lineTo(11, 2);
            cx.lineTo(14, 5);
            cx.lineTo(6, 13);
            cx.lineTo(2, 14);
            cx.closePath();
            cx.moveTo(9, 4);
            cx.lineTo(12, 7);
            break;
          case 'archive':
            cx.rect(1.5, 2, 13, 3);
            cx.moveTo(3, 5);
            cx.lineTo(3, 14);
            cx.lineTo(13, 14);
            cx.lineTo(13, 5);
            cx.moveTo(6, 8);
            cx.lineTo(10, 8);
            break;
          case 'trash':
            cx.moveTo(2, 4);
            cx.lineTo(14, 4);
            cx.moveTo(5, 4);
            cx.lineTo(5, 2);
            cx.lineTo(11, 2);
            cx.lineTo(11, 4);
            cx.moveTo(3.5, 4);
            cx.lineTo(4.5, 14);
            cx.lineTo(11.5, 14);
            cx.lineTo(12.5, 4);
            cx.moveTo(6, 7);
            cx.lineTo(6.5, 11.5);
            cx.moveTo(10, 7);
            cx.lineTo(9.5, 11.5);
            break;
          case 'copy':
            cx.roundRect(2, 1.5, 9, 10, 1.5);
            cx.roundRect(5, 4.5, 9, 10, 1.5);
            break;
          case 'wrap':
            cx.moveTo(2, 3.5);
            cx.lineTo(14, 3.5);
            cx.moveTo(2, 7.5);
            cx.lineTo(11.5, 7.5);
            cx.arc(11.5, 10, 2.5, -Math.PI / 2, Math.PI / 2);
            cx.lineTo(7, 12.5);
            cx.moveTo(9, 10.5);
            cx.lineTo(7, 12.5);
            cx.lineTo(9, 14.5);
            cx.moveTo(2, 11.5);
            cx.lineTo(4, 11.5);
            break;
          case 'nowrap':
            cx.moveTo(2, 3.5);
            cx.lineTo(14, 3.5);
            cx.moveTo(2, 7.5);
            cx.lineTo(14, 7.5);
            cx.moveTo(12, 5.5);
            cx.lineTo(14, 7.5);
            cx.lineTo(12, 9.5);
            cx.moveTo(2, 11.5);
            cx.lineTo(9, 11.5);
            break;
          case 'code':
            cx.moveTo(6, 4);
            cx.lineTo(2, 8);
            cx.lineTo(6, 12);
            cx.moveTo(10, 4);
            cx.lineTo(14, 8);
            cx.lineTo(10, 12);
            break;
          case 'check':
            cx.moveTo(3, 8);
            cx.lineTo(6.5, 11.5);
            cx.lineTo(13, 4.5);
            break;
          case 'more':
            for (const x of [3, 8, 13]) {
              cx.moveTo(x + 1, 8);
              cx.arc(x, 8, 1, 0, Math.PI * 2);
            }
            cx.fill();
            return;
          case 'latest':
            cx.moveTo(8, 2);
            cx.lineTo(8, 12);
            cx.moveTo(3.5, 7.5);
            cx.lineTo(8, 12);
            cx.lineTo(12.5, 7.5);
            break;
          case 'paperclip':
            cx.moveTo(5, 11);
            cx.lineTo(10, 6);
            cx.arc(9, 5, 1.5, -0.8, Math.PI * 1.2, true);
            cx.lineTo(4, 9);
            cx.arc(6, 11, 3, Math.PI * 1.2, 0.2, true);
            cx.lineTo(13, 6);
            break;
          case 'queue':
            for (const y of [4, 8, 12]) {
              cx.moveTo(2, y);
              cx.lineTo(11, y);
            }
            cx.moveTo(12, 9);
            cx.lineTo(15, 12);
            cx.lineTo(12, 15);
            break;
          case 'edit':
            cx.moveTo(3, 10);
            cx.lineTo(11, 2);
            cx.lineTo(14, 5);
            cx.lineTo(6, 13);
            cx.lineTo(2, 14);
            cx.closePath();
            cx.moveTo(9, 4);
            cx.lineTo(12, 7);
            break;
          case 'image':
            cx.roundRect(1.5, 2, 13, 12, 2);
            cx.moveTo(2, 12);
            cx.lineTo(6, 8);
            cx.lineTo(9, 11);
            cx.lineTo(11, 9);
            cx.lineTo(14, 12);
            cx.moveTo(11, 5.5);
            cx.arc(10, 5.5, 1, 0, Math.PI * 2);
            break;
          case 'fork':
            cx.arc(5, 3, 1.5, 0, Math.PI * 2);
            cx.moveTo(5, 4.5);
            cx.lineTo(5, 11.5);
            cx.moveTo(6.5, 13);
            cx.arc(5, 13, 1.5, 0, Math.PI * 2);
            cx.moveTo(5, 9);
            cx.lineTo(11, 6);
            cx.lineTo(11, 4.5);
            cx.moveTo(12.5, 3);
            cx.arc(11, 3, 1.5, 0, Math.PI * 2);
            break;
          case 'shield':
            cx.moveTo(8, 1.5);
            cx.lineTo(13.5, 4);
            cx.lineTo(12.5, 10);
            cx.lineTo(8, 14.5);
            cx.lineTo(3.5, 10);
            cx.lineTo(2.5, 4);
            cx.closePath();
            break;
          case 'lock':
            cx.roundRect(3, 7, 10, 7, 2);
            cx.moveTo(5, 7);
            cx.lineTo(5, 4.5);
            cx.arc(8, 4.5, 3, Math.PI, 0);
            cx.lineTo(11, 7);
            break;
          case 'activity':
            cx.arc(8, 8, 6, 0, Math.PI * 2);
            cx.moveTo(8, 4);
            cx.lineTo(8, 8);
            cx.lineTo(11, 9.5);
            break;
          case 'unread':
            cx.arc(8, 8, 2.5, 0, Math.PI * 2);
            cx.fill();
            return;
        }
        cx.stroke();
      }}
    />
  );
}
