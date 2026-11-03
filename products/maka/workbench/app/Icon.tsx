// Canvas drawing adapted from NSH Gallery icons.tsx (Apache-2.0).
// Copyright 2026 Longbridge <https://longbridge.com>.
// Lucide geometry is ISC / Feather MIT; see LICENSE.

import { Canvas, Path2D, Text, type CanvasRenderingContext2D } from 'nsh';
import { platform } from 'nsh';
import { lucide, type LucideElement } from './lucide';

const glyphs = {
  back: '‹',
  sidebar: '◫',
  split: '◫',
  sidebarCollapse: '◁',
  sidebarExpand: '▷',
  plus: '+',
  send: '↑',
  stop: '■',
  pause: 'Ⅱ',
  play: '▶',
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
  pin: '📌',
  trash: '⌫',
  wrap: '↵',
  nowrap: '→',
  code: '⌘',
  markdown: 'M',
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
  thinking: '◌',
  statusRecorded: '●',
  statusSuccess: '✓',
  statusError: '×',
  statusUnknown: '?',
  statusStopped: 'Ⅱ',
  statusDispatched: '↑',
  statusPending: '○',
  loader: '◌',
  unread: '●',
};

const iconNames = {
  back: 'chevron-left',
  sidebar: 'panel-left',
  split: 'columns-2',
  sidebarCollapse: 'panel-left-close',
  sidebarExpand: 'panel-left-open',
  plus: 'plus',
  send: 'arrow-up',
  stop: 'square',
  pause: 'pause',
  play: 'play',
  close: 'x',
  down: 'chevron-down',
  right: 'chevron-right',
  search: 'search',
  settings: 'settings',
  folder: 'folder',
  refresh: 'refresh-cw',
  file: 'file',
  terminal: 'square-terminal',
  command: 'command',
  copy: 'copy',
  archive: 'archive',
  pin: 'pin',
  trash: 'trash',
  wrap: 'text-wrap',
  nowrap: 'move-right',
  code: 'code',
  markdown: 'markdown',
  check: 'check',
  more: 'ellipsis',
  latest: 'arrow-down',
  paperclip: 'paperclip',
  queue: 'list-end',
  edit: 'pencil',
  image: 'image',
  expand: 'maximize',
  fork: 'git-fork',
  shield: 'shield',
  lock: 'lock',
  activity: 'clock',
  thinking: 'brain',
  statusRecorded: 'circle-dot',
  statusSuccess: 'circle-check',
  statusError: 'circle-x',
  statusUnknown: 'circle-question-mark',
  statusStopped: 'circle-pause',
  statusDispatched: 'circle-arrow-up',
  statusPending: 'circle',
  loader: 'loader-circle',
  unread: 'circle',
} satisfies Record<keyof typeof glyphs, keyof typeof lucide>;

const paths = new Map<string, Path2D>();
const pointLists = new Map<string, number[]>();
for (const elements of Object.values(lucide)) {
  for (const el of elements as LucideElement[]) {
    if (el.tag === 'path') paths.set(el.d, new Path2D(el.d));
    if (el.tag === 'polygon' || el.tag === 'polyline') pointLists.set(el.points, points(el.points));
  }
}

function points(list: string): number[] {
  return list
    .trim()
    .split(/[\s,]+/)
    .map(Number);
}

/** Draws one element as Lucide's SVG does: stroked, never filled. */
function draw(cx: CanvasRenderingContext2D, el: LucideElement) {
  switch (el.tag) {
    case 'path':
      cx.stroke(paths.get(el.d)!);
      return;
    case 'circle':
      cx.beginPath();
      cx.arc(el.cx, el.cy, el.r, 0, Math.PI * 2);
      break;
    case 'ellipse':
      cx.beginPath();
      cx.ellipse(el.cx, el.cy, el.rx, el.ry, 0, 0, Math.PI * 2);
      break;
    case 'rect':
      cx.beginPath();
      cx.roundRect(el.x, el.y, el.width, el.height, el.rx ?? 0);
      break;
    case 'line':
      cx.beginPath();
      cx.moveTo(el.x1, el.y1);
      cx.lineTo(el.x2, el.y2);
      break;
    case 'polyline':
    case 'polygon': {
      const p = pointLists.get(el.points)!;
      cx.beginPath();
      cx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) cx.lineTo(p[i], p[i + 1]);
      if (el.tag === 'polygon') cx.closePath();
      break;
    }
  }
  cx.stroke();
}

export function Icon(props: { name: keyof typeof glyphs; color: string; size?: number }) {
  if (platform.isTerminal)
    return (
      <Text
        accessibilityElementsHidden
        style={[
          {
            width: 16,
            height: 16,
            lineHeight: 16,
            color: props.color,
            textAlign: 'center',
            flexShrink: 0,
          },
          { userSelect: 'none', pointerEvents: 'none' },
        ]}
      >
        {glyphs[props.name]}
      </Text>
    );
  return (
    <Canvas
      accessibilityElementsHidden
      style={[
        { width: props.size ?? 16, height: props.size ?? 16, flexShrink: 0 },
        { pointerEvents: 'none' },
      ]}
      draw={(cx) => {
        cx.scale((props.size ?? 16) / 24, (props.size ?? 16) / 24);
        cx.strokeStyle = props.color;
        cx.fillStyle = props.color;
        cx.lineWidth = 2;
        cx.lineCap = 'round';
        cx.lineJoin = 'round';
        if (props.name === 'unread') {
          cx.beginPath();
          cx.arc(12, 12, 3.75, 0, Math.PI * 2);
          cx.fill();
          return;
        }
        for (const el of lucide[iconNames[props.name]] as LucideElement[]) {
          if (props.name === 'play' || props.name === 'stop' || props.name === 'pause') {
            // Transport controls retain their filled affordance.
            if (el.tag === 'path') cx.fill(paths.get(el.d)!);
            else if (el.tag === 'rect') {
              cx.beginPath();
              cx.roundRect(el.x, el.y, el.width, el.height, el.rx ?? 0);
              cx.fill();
            }
          } else draw(cx, el);
        }
      }}
    />
  );
}
