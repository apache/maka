// Canvas drawing adapted from NSH Gallery icons.tsx (Apache-2.0).
// Copyright 2026 Longbridge <https://longbridge.com>.
// Lucide geometry is ISC / Feather MIT; see LICENSE.

import { Canvas, Path2D, Text, type CanvasRenderingContext2D } from 'nsh';
import { platform } from 'nsh';
import { lucide, type LucideElement } from './lucide';

const icons = {
  book: { lucide: 'book', glyph: '📖' },
  back: { lucide: 'chevron-left', glyph: '‹' },
  sidebar: { lucide: 'panel-left', glyph: '◫' },
  split: { lucide: 'columns-2', glyph: '◫' },
  sidebarCollapse: { lucide: 'panel-left-close', glyph: '◁' },
  sidebarExpand: { lucide: 'panel-left-open', glyph: '▷' },
  plus: { lucide: 'plus', glyph: '+' },
  send: { lucide: 'arrow-up', glyph: '↑' },
  stop: { lucide: 'square', glyph: '■' },
  pause: { lucide: 'pause', glyph: 'Ⅱ' },
  play: { lucide: 'play', glyph: '▶' },
  close: { lucide: 'x', glyph: '×' },
  down: { lucide: 'chevron-down', glyph: '⌄' },
  up: { lucide: 'chevron-up', glyph: '⌃' },
  right: { lucide: 'chevron-right', glyph: '›' },
  search: { lucide: 'search', glyph: '⌕' },
  settings: { lucide: 'settings', glyph: '⚙' },
  folder: { lucide: 'folder', glyph: '📁' },
  refresh: { lucide: 'refresh-cw', glyph: '↻' },
  file: { lucide: 'file', glyph: '📄' },
  terminal: { lucide: 'square-terminal', glyph: '⌁' },
  command: { lucide: 'command', glyph: '⌘' },
  copy: { lucide: 'copy', glyph: '⧉' },
  archive: { lucide: 'archive', glyph: '▤' },
  pin: { lucide: 'pin', glyph: '📌' },
  trash: { lucide: 'trash', glyph: '⌫' },
  wrap: { lucide: 'text-wrap', glyph: '↵' },
  nowrap: { lucide: 'move-right', glyph: '→' },
  code: { lucide: 'code', glyph: '⌘' },
  markdown: { lucide: 'markdown', glyph: 'M' },
  check: { lucide: 'check', glyph: '✓' },
  more: { lucide: 'ellipsis', glyph: '⋯' },
  latest: { lucide: 'arrow-down', glyph: '↓' },
  paperclip: { lucide: 'paperclip', glyph: '📎' },
  queue: { lucide: 'list-end', glyph: '≡' },
  edit: { lucide: 'pencil', glyph: '✎' },
  image: { lucide: 'image', glyph: '▧' },
  expand: { lucide: 'maximize', glyph: '⛶' },
  fork: { lucide: 'git-fork', glyph: '⑂' },
  shield: { lucide: 'shield', glyph: '◇' },
  lock: { lucide: 'lock', glyph: '▣' },
  activity: { lucide: 'clock', glyph: '◌' },
  bot: { lucide: 'bot', glyph: '◌' },
  inbox: { lucide: 'inbox', glyph: '?' },
  thinking: { lucide: 'brain', glyph: '◌' },
  statusRecorded: { lucide: 'circle-dot', glyph: '●' },
  statusSuccess: { lucide: 'circle-check', glyph: '✓' },
  statusError: { lucide: 'circle-x', glyph: '×' },
  statusUnknown: { lucide: 'circle-question-mark', glyph: '?' },
  statusStopped: { lucide: 'circle-pause', glyph: 'Ⅱ' },
  statusDispatched: { lucide: 'circle-arrow-up', glyph: '↑' },
  statusPending: { lucide: 'circle', glyph: '○' },
  loader: { lucide: 'loader-circle', glyph: '◌' },
  unread: { lucide: 'circle', glyph: '●' },
} satisfies Record<string, { lucide: keyof typeof lucide; glyph: string }>;

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

export function Icon(props: { name: keyof typeof icons; color: string; size?: number }) {
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
        {icons[props.name].glyph}
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
        for (const el of lucide[icons[props.name].lucide] as LucideElement[]) {
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
