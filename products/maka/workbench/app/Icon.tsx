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
  minus: { lucide: 'minus', glyph: '−' },
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
  goal: { lucide: 'goal', glyph: '◎' },
  children: { lucide: 'list-tree', glyph: '⊢' },
  compaction: { lucide: 'fold-vertical', glyph: '⇕' },
  readOnly: { lucide: 'eye', glyph: '◉' },
  workspaceWrite: { lucide: 'file-pen', glyph: '✎' },
  sandboxOff: { lucide: 'shield-off', glyph: '◇' },
  approval: { lucide: 'hand', glyph: '✋' },
  shield: { lucide: 'shield', glyph: '◇' },
  lock: { lucide: 'lock', glyph: '▣' },
  activity: { lucide: 'clock', glyph: '◌' },
  bot: { lucide: 'bot', glyph: '◌' },
  conversation: { lucide: 'message-square', glyph: '▱' },
  user: { lucide: 'user-round', glyph: '●' },
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
  app: { lucide: 'app-window', glyph: '▢' },
  calculator: { lucide: 'calculator', glyph: '=' },
  mic: { lucide: 'mic', glyph: '🎙' },
  camera: { lucide: 'camera', glyph: '◉' },
  clipboard: { lucide: 'clipboard-list', glyph: '▤' },
  link: { lucide: 'link', glyph: '∞' },
  note: { lucide: 'sticky-note', glyph: '▭' },
  snippet: { lucide: 'text-quote', glyph: '❝' },
  symbol: { lucide: 'hash', glyph: '#' },
  rectangle: { lucide: 'square', glyph: '□' },
  ellipse: { lucide: 'circle', glyph: '○' },
  arrow: { lucide: 'move-up-right', glyph: '↗' },
  pen: { lucide: 'pencil', glyph: '✎' },
  marker: { lucide: 'highlighter', glyph: '▌' },
  text: { lucide: 'type', glyph: 'T' },
  mosaic: { lucide: 'grid-3x3', glyph: '▦' },
  number: { lucide: 'list-ordered', glyph: '①' },
  undo: { lucide: 'undo-2', glyph: '↶' },
  redo: { lucide: 'redo-2', glyph: '↷' },
  download: { lucide: 'download', glyph: '↓' },
  panelRight: { custom: 'panelRight', glyph: '◫' },
  panelRightClose: { custom: 'panelRightClose', glyph: '▷' },
  panelRightOpen: { custom: 'panelRightOpen', glyph: '◁' },
  inspector: { custom: 'inspector', glyph: '▤' },
  pullRequest: { custom: 'pullRequest', glyph: '⊶' },
  gitBranch: { custom: 'gitBranch', glyph: '⑂' },
  gitCommit: { custom: 'gitCommit', glyph: '●' },
  diff: { custom: 'diff', glyph: '±' },
  minimize: { custom: 'minimize', glyph: '⤡' },
  globe: { custom: 'globe', glyph: '⊕' },
  eye: { lucide: 'eye', glyph: '◉' },
  eyeOff: { custom: 'eyeOff', glyph: '◌' },
  rooms: { custom: 'rooms', glyph: '◎' },
  smilePlus: { custom: 'smilePlus', glyph: '☺' },
  reply: { custom: 'reply', glyph: '↩' },
  warning: { custom: 'warning', glyph: '!' },
  info: { custom: 'info', glyph: 'i' },
  ask: { custom: 'ask', glyph: '❝' },
} satisfies Record<
  string,
  | { lucide: keyof typeof lucide; glyph: string }
  | { custom: keyof typeof customIcons; glyph: string }
>;

const customIcons = {
  panelRight: [
    { tag: 'rect', x: 3, y: 3, width: 18, height: 18, rx: 2 },
    { tag: 'path', d: 'M15 3v18' },
  ],
  panelRightClose: [
    { tag: 'rect', x: 3, y: 3, width: 18, height: 18, rx: 2 },
    { tag: 'path', d: 'M15 3v18' },
    { tag: 'path', d: 'm8 9 3 3-3 3' },
  ],
  panelRightOpen: [
    { tag: 'rect', x: 3, y: 3, width: 18, height: 18, rx: 2 },
    { tag: 'path', d: 'M15 3v18' },
    { tag: 'path', d: 'm10 15-3-3 3-3' },
  ],
  inspector: [
    { tag: 'rect', x: 3, y: 4, width: 18, height: 16, rx: 2 },
    { tag: 'path', d: 'M7 9h5' },
    { tag: 'path', d: 'M7 13h7' },
    { tag: 'path', d: 'M16 9h1' },
    { tag: 'path', d: 'M16 13h1' },
  ],
  pullRequest: [
    { tag: 'circle', cx: 6, cy: 6, r: 3 },
    { tag: 'circle', cx: 18, cy: 18, r: 3 },
    { tag: 'path', d: 'M13 6h3a2 2 0 0 1 2 2v7' },
    { tag: 'line', x1: 6, y1: 9, x2: 6, y2: 21 },
  ],
  gitBranch: [
    { tag: 'line', x1: 6, y1: 3, x2: 6, y2: 15 },
    { tag: 'circle', cx: 18, cy: 6, r: 3 },
    { tag: 'circle', cx: 6, cy: 18, r: 3 },
    { tag: 'path', d: 'M18 9a9 9 0 0 1-9 9' },
  ],
  gitCommit: [
    { tag: 'circle', cx: 12, cy: 12, r: 3 },
    { tag: 'line', x1: 3, y1: 12, x2: 9, y2: 12 },
    { tag: 'line', x1: 15, y1: 12, x2: 21, y2: 12 },
  ],
  diff: [
    { tag: 'path', d: 'M12 4v10' },
    { tag: 'path', d: 'M7 9h10' },
    { tag: 'path', d: 'M7 19h10' },
  ],
  minimize: [
    { tag: 'path', d: 'M4 14h6v6' },
    { tag: 'path', d: 'M20 10h-6V4' },
    { tag: 'path', d: 'm14 10 7-7' },
    { tag: 'path', d: 'm3 21 7-7' },
  ],
  globe: [
    { tag: 'circle', cx: 12, cy: 12, r: 10 },
    { tag: 'path', d: 'M2 12h20' },
    {
      tag: 'path',
      d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
    },
  ],
  eyeOff: [
    { tag: 'path', d: 'M9.88 9.88a3 3 0 1 0 4.24 4.24' },
    {
      tag: 'path',
      d: 'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68',
    },
    { tag: 'path', d: 'M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61' },
    { tag: 'line', x1: 2, y1: 2, x2: 22, y2: 22 },
  ],
  rooms: [
    { tag: 'path', d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' },
    { tag: 'circle', cx: 9, cy: 7, r: 4 },
    { tag: 'path', d: 'M22 21v-2a4 4 0 0 0-3-3.87' },
    { tag: 'path', d: 'M16 3.13a4 4 0 0 1 0 7.75' },
  ],
  smilePlus: [
    { tag: 'path', d: 'M22 11v1a10 10 0 1 1-9-10' },
    { tag: 'path', d: 'M8 14s1.5 2 4 2 4-2 4-2' },
    { tag: 'line', x1: 9, y1: 9, x2: 9.01, y2: 9 },
    { tag: 'line', x1: 15, y1: 9, x2: 15.01, y2: 9 },
    { tag: 'path', d: 'M16 5h6' },
    { tag: 'path', d: 'M19 2v6' },
  ],
  ask: [
    {
      tag: 'path',
      d: 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z',
    },
    { tag: 'path', d: 'M14 13a2 2 0 0 0 2-2V9h-2' },
    { tag: 'path', d: 'M8 13a2 2 0 0 0 2-2V9H8' },
  ],
  reply: [
    { tag: 'polyline', points: '9 17 4 12 9 7' },
    { tag: 'path', d: 'M20 18v-2a4 4 0 0 0-4-4H4' },
  ],
  warning: [
    { tag: 'path', d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' },
    { tag: 'path', d: 'M12 9v4' },
    { tag: 'path', d: 'M12 17h.01' },
  ],
  info: [
    { tag: 'circle', cx: 12, cy: 12, r: 10 },
    { tag: 'path', d: 'M12 16v-4' },
    { tag: 'path', d: 'M12 8h.01' },
  ],
} satisfies Record<string, LucideElement[]>;

const paths = new Map<string, Path2D>();
const pointLists = new Map<string, number[]>();
for (const elements of [...Object.values(lucide), ...Object.values(customIcons)]) {
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
  if (platform.idiom === 'terminal')
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
        const spec = icons[props.name];
        const elements = (
          'lucide' in spec ? lucide[spec.lucide] : customIcons[spec.custom]
        ) as LucideElement[];
        for (const el of elements) {
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
