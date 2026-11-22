import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Exercise the runtime's marker generation, rather than a copy of its math.
const source = readFileSync(new URL('../../crates/nsh-platform-web/web/nsh.js', import.meta.url), 'utf8');
const start = source.indexOf('  snapMarkers(el) {');
const method = source.slice(start, source.indexOf('\n  op_sticky(', start));
const player = new Function('document', `return ({${method}});`)({
  createElement: () => ({ style: {}, remove() {} }),
});

function scroll(behavior = {}, horizontal = true, viewport = 300, content = 1000) {
  return {
    _behavior: { snapInterval: 0, snapOffsets: [], paging: false, snapAlignment: 'start', ...behavior },
    _horizontal: horizontal,
    _content: horizontal ? [content, 100] : [100, content],
    _frame: horizontal ? [0, 0, viewport, 100] : [0, 0, 100, viewport],
    _snapPoints: null as number[] | null,
    _markers: [] as { style: { cssText: string }; className: string; remove(): void }[],
    classList: { remove() {}, add() {} },
    append() {},
  };
}

test('interval snapping includes the partial final interval on either axis', () => {
  for (const horizontal of [true, false]) {
    const el = scroll({ snapInterval: 120 }, horizontal);
    player.snapMarkers(el);
    expect(el._snapPoints).toEqual([0, 120, 240, 360, 480, 600, 700]);
    expect(el._markers.at(-1)?.style.cssText).toBe(horizontal ? 'left:700px' : 'top:700px');
  }
});

test('center and end alignment match the shared scroll snap points', () => {
  const el = scroll({ snapInterval: 120, snapAlignment: 'center' });
  player.snapMarkers(el);
  expect(el._snapPoints).toEqual([0, 30, 150, 270, 390, 510, 630, 700]);
  el._behavior.snapAlignment = 'end';
  player.snapMarkers(el);
  expect(el._snapPoints).toEqual([0, 0, 60, 180, 300, 420, 540, 660, 700]);
});

test('paging includes the final partial page', () => {
  const el = scroll({ paging: true });
  player.snapMarkers(el);
  expect(el._snapPoints).toEqual([0, 300, 600, 700]);
});

test('explicit offsets are clamped and sorted for keyboard snapping', () => {
  const el = scroll({ snapOffsets: [900, -20, 240] });
  player.snapMarkers(el);
  expect(el._snapPoints).toEqual([0, 240, 700]);
  expect(el._markers.map(m => m.style.cssText)).toEqual(['left:700px', 'left:0px', 'left:240px']);
});

test('interval takes precedence over offsets and paging', () => {
  const el = scroll({ snapInterval: 400, snapOffsets: [100], paging: true });
  player.snapMarkers(el);
  expect(el._snapPoints).toEqual([0, 400, 700]);
});

test('content smaller than the viewport stays at zero', () => {
  const el = scroll({ snapInterval: 120, snapAlignment: 'end' }, true, 300, 100);
  player.snapMarkers(el);
  expect(el._snapPoints?.every(p => p === 0)).toBe(true);
});

test('rebuilding markers uses the latest viewport and clears disabled snapping', () => {
  const el = scroll({ paging: true });
  player.snapMarkers(el);
  let removed = 0;
  for (const m of el._markers) m.remove = () => { removed++; };
  el._frame[2] = 400;
  player.snapMarkers(el);
  expect(removed).toBe(4);
  expect(el._snapPoints).toEqual([0, 400, 600]);
  el._behavior.paging = false;
  player.snapMarkers(el);
  expect(el._snapPoints).toBe(null);
  expect(el._markers).toEqual([]);
});
