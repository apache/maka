import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Exercise the production player without starting its WebAssembly engine.
const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
const { Player } = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64'));
const player = Object.create(Player.prototype);
player.idiom = "desktop";
const shown = [];
player.showBar = (el) => shown.push(el);
function scroll(horizontal = false, left = 40, top = 30) {
  return {
    _kind: 'scroll', _indicator: true, _horizontal: horizontal,
    clientWidth: 300, clientHeight: 200, scrollWidth: horizontal ? 1200 : 300,
    scrollHeight: horizontal ? 200 : 800, scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left, top }),
  };
}

test('content hover leaves visibility and fade timer alone', () => {
  shown.length = 0;
  const el = scroll();
  el._barTimer = 123;
  player.hoverBar(el, { clientX: 150, clientY: 100 });
  assert.equal(shown.length, 0);
  assert.equal(el._barTimer, 123);
  player.hoverBar(el, { clientX: 338, clientY: 35 });
  assert.deepEqual(shown, [el]);
  shown.length = 0;
  player.hoverBar(el, { clientX: 338, clientY: 180 });
  assert.equal(shown.length, 0);
});

test('horizontal and nested scroll views use their own coordinates', () => {
  shown.length = 0;
  const outer = scroll(false, 0, 0);
  const inner = scroll(true, 40, 30);
  const e = { clientX: 45, clientY: 228 };
  for (const el of [inner, outer]) player.hoverBar(el, e);
  assert.deepEqual(shown, [inner]);
});

test('disabled, fitting and phone scroll views do not reveal an overlay', () => {
  shown.length = 0;
  const el = scroll();
  const e = { clientX: 338, clientY: 35 };
  el._behavior = { enabled: false };
  player.hoverBar(el, e);
  el._behavior.enabled = true;
  el.scrollHeight = el.clientHeight;
  player.hoverBar(el, e);
  el.scrollHeight = 800;
  player.idiom = "phone";
  player.hoverBar(el, e);
  player.idiom = "desktop";
  assert.equal(shown.length, 0);
});

test('scrollbar={false} hides the bar on either axis', () => {
  for (const horizontal of [false, true]) {
    const el = scroll(horizontal);
    assert.equal(player.barShown(el), true);
    el._indicator = false;
    assert.equal(player.barShown(el), false);
    // A built-in bar of the app's takes its place.
    el._indicator = true;
    el._replaced = true;
    assert.equal(player.barShown(el), false);
  }
});

test('scrollbarInset keeps the bar clear of bars floating over the view', () => {
  shown.length = 0;
  const el = scroll();
  el._behavior = { enabled: true, bar: [20, 10, 60, 0] };
  // Its track runs between the top and bottom insets.
  assert.deepEqual(player.barThumb(el).slice(0, 2), [22, 32]);
  el.scrollTop = 600;
  const [start, len] = player.barThumb(el);
  assert.equal(start + len, 200 - 60 - 2);
  el.scrollTop = 0;
  // It runs along the right edge moved in by the right inset.
  assert.equal(player.barEdge(el), 290);
  player.hoverBar(el, { clientX: 40 + 285, clientY: 30 + 30 });
  assert.deepEqual(shown, [el]);
  shown.length = 0;
  player.hoverBar(el, { clientX: 40 + 295, clientY: 30 + 30 });
  player.hoverBar(el, { clientX: 40 + 285, clientY: 30 + 10 });
  assert.equal(shown.length, 0);
  // No room between the insets: no bar.
  el._behavior.bar = [100, 0, 95, 0];
  assert.equal(player.barThumb(el), null);
  // A horizontal one runs between the left and right insets, up by the bottom one.
  const h = scroll(true);
  h._behavior = { enabled: true, bar: [0, 30, 20, 10] };
  assert.equal(player.barThumb(h)[0], 12);
  assert.equal(player.barEdge(h), 180);
});

// Sticky list cells: the few DOM operations their tracks use.
class Node {
  constructor(props) {
    const names = new Set();
    const classList = {
      add: (name) => names.add(name),
      remove: (name) => names.delete(name),
      toggle: (name, on) => (on ? names.add(name) : names.delete(name)),
      contains: (name) => names.has(name),
    };
    Object.assign(this, { parentNode: null, children: [], style: {}, className: '', classList }, props);
  }
  get nextSibling() {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  insertBefore(child, before) {
    child.remove();
    const at = before ? this.children.indexOf(before) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
    child.parentNode = this;
  }
  append(child) {
    this.insertBefore(child, null);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceWith(other) {
    this.parentNode.insertBefore(other, this);
    this.remove();
  }
}
globalThis.document = { createElement: () => new Node() };

/** A list 300 wide with cells 1, 3 and 5 at 0, 40 and 500, 40 tall. */
function list(horizontal = false) {
  const p = Object.create(Player.prototype);
  p.views = new Map();
  const el = new Node({ _id: 0, _kind: 'scroll', _horizontal: horizontal, _spacer: new Node() });
  el.append(el._spacer);
  p.views.set(0, el);
  for (const [id, at] of [[1, 0], [3, 40], [5, 500]]) {
    const cell = new Node({ _id: id });
    p.views.set(id, cell);
    el.append(cell);
    p.op_f(['f', id, ...(horizontal ? [at, 0, 40, 300] : [0, at, 300, 40])]);
  }
  return { p, el, cell: (id) => p.views.get(id) };
}

test('sticky cells stick in tracks along their travel', () => {
  const { p, el, cell } = list();
  p.op_sticky(['sticky', 0, [[1, 0, 460], [5, 500, 1e9]]]);
  p.op_scs(['scs', 0, 300, 1000]);
  const track = cell(1).parentNode;
  assert.equal(track.className, 'nsh-track');
  assert.equal(track.parentNode, el);
  // Their z-index stays inside the list.
  assert.ok(el.classList.contains('nsh-sticky'));
  // Pushed out where the next one's track starts, at 500.
  assert.deepEqual(track.style, { left: '0px', top: '0px', width: '0px', height: '500px' });
  assert.deepEqual(cell(1).style, { left: 'auto', top: '0px', width: '300px', height: '40px' });
  assert.equal(cell(3).parentNode, el);
  // The last one travels to the end of the content, as it grows.
  assert.equal(cell(5).parentNode.style.height, '500px');
  p.op_scs(['scs', 0, 300, 1200]);
  assert.equal(cell(5).parentNode.style.height, '700px');
  // A new frame moves the track, and the cell stays in it.
  const last = cell(5).parentNode;
  p.op_f(['f', 5, 0, 520, 300, 40]);
  p.op_sticky(['sticky', 0, [[1, 0, 480], [5, 520, 1e9]]]);
  assert.equal(cell(5).parentNode, last);
  assert.deepEqual([last.style.top, last.style.height, cell(5).style.top], ['520px', '680px', '0px']);
});

test('the last track ends at its cell until the content size arrives', () => {
  const { p, cell } = list();
  p.op_sticky(['sticky', 0, [[5, 500, 1e9]]]);
  assert.equal(cell(5).parentNode.style.height, '40px');
});

test('cells that stop being sticky go back to their frames', () => {
  const { p, el, cell } = list();
  p.op_sticky(['sticky', 0, [[1, 0, 460], [5, 500, 1e9]]]);
  const track = cell(1).parentNode;
  // Recycled: cell 1 shows a row at 900 now.
  p.op_f(['f', 1, 0, 900, 300, 40]);
  p.op_sticky(['sticky', 0, [[5, 500, 1e9]]]);
  assert.equal(cell(1).parentNode, el);
  assert.equal(el.children.includes(track), false);
  assert.deepEqual(cell(1).style, { left: '0px', top: '900px', width: '300px', height: '40px' });
  // A removed cell takes its track along.
  const last = cell(5).parentNode;
  p.views.delete(5);
  p.op_sticky(['sticky', 0, []]);
  assert.equal(el.children.includes(last), false);
  assert.ok(!el.classList.contains('nsh-sticky'));
});

test('sticky cells of horizontal lists travel along x', () => {
  const { p, cell } = list(true);
  p.op_sticky(['sticky', 0, [[1, 0, 460], [5, 500, 1e9]]]);
  p.op_scs(['scs', 0, 1000, 300]);
  assert.deepEqual(cell(1).parentNode.style, { left: '0px', top: '0px', width: '500px', height: '0px' });
  assert.deepEqual(cell(1).style, { left: '0px', top: 'auto', width: '40px', height: '300px' });
});

test('tracks stay with the cells in a content layer', () => {
  // A layer made after the tracks takes them along.
  const before = list();
  before.p.op_sticky(['sticky', 0, [[1, 0, 460]]]);
  const layer = before.p.ensureLayer(before.el);
  assert.equal(before.cell(1).parentNode.parentNode, layer);
  assert.equal(before.cell(3).parentNode, layer);
  // Tracks made after it go into it.
  const after = list();
  after.p.ensureLayer(after.el);
  after.p.op_sticky(['sticky', 0, [[1, 0, 460]]]);
  assert.equal(after.cell(1).parentNode.parentNode, after.el._layer);
});

// Wheel and key glides (`scrollSmoothly`): their animation frames run one
// at a time, a frame apart on the tests' clock (`performance.now`).
const frames = new Map();
let lastFrame = 0;
let clock = 0;
globalThis.requestAnimationFrame = (f) => (frames.set(++lastFrame, f), lastFrame);
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
function runFrames(n = 120) {
  for (let i = 0; i < n && frames.size; i++) {
    clock += 16.7;
    const due = [...frames.values()];
    frames.clear();
    for (const f of due) f(clock);
  }
}

/** A vertical scroll view 300 × 200 with content 5000 tall, at the top, and
 * in it `full`, a scroll view whose content fits: a wheel over it is one the
 * browser would leave on `full`, so nsh scrolls the outer view itself
 * (`wheel`), as the glide tests need. */
function scroller() {
  const p = Object.create(Player.prototype);
  p.root = { parentNode: null };
  p.size = [300, 200];
  // A scroll that ends and a scroll key tell the engine (`nsh_scroll_ended`,
  // `nsh_key_scroll`), which these players run without; -1: the engine is
  // not due again (`schedule`).
  p.keyScrolls = [];
  p.wasm = {
    nsh_scroll_ended: () => -1,
    nsh_scroll: () => -1,
    nsh_key_scroll: (id, kind, amount) => (p.keyScrolls.push([id, kind, amount]), -1),
  };
  const el = {
    _id: 1, _kind: 'scroll', _events: new Set(), _applied: 0, parentNode: p.root,
    clientWidth: 300, clientHeight: 200, scrollWidth: 300, scrollHeight: 5000, scrollLeft: 0, scrollTop: 0,
    scrollTo({ left, top }) {
      this.scrollLeft = Math.min(Math.max(left, 0), this.scrollWidth - this.clientWidth);
      this.scrollTop = Math.min(Math.max(top, 0), this.scrollHeight - this.clientHeight);
    },
  };
  const full = {
    _id: 3, _kind: 'scroll', _events: new Set(), _applied: 0, parentNode: el, isConnected: true,
    clientWidth: 300, clientHeight: 100, scrollWidth: 300, scrollHeight: 100, scrollLeft: 0, scrollTop: 0,
  };
  p.views = new Map([[1, el], [3, full]]);
  return { p, el, full };
}
const wheel = (el, deltaY) => ({ deltaMode: 0, deltaX: 0, deltaY, target: el, preventDefault() {} });
/** A wheel event over `target` that records whether it was prevented. */
function tracked(target, deltaY, deltaMode = 0) {
  const e = { deltaMode, deltaX: 0, deltaY, target, prevented: false };
  e.preventDefault = () => { e.prevented = true; };
  return e;
}

test('scroll commands win over a wheel or key glide', (t) => {
  t.mock.method(performance, 'now', () => clock);
  const commands = [
    [['cmd', 1, 'scrollTo', 0, 0, false], 0],
    [['cmd', 1, 'scrollTo', 0, 0, true], 0],
    [['cmd', 1, 'scrollToEnd', false], 4800],
  ];
  for (const key of [false, true]) {
    for (const [command, end] of commands) {
      const { p, el, full } = scroller();
      if (key) p.scrollKey({ key: 'PageDown', shiftKey: false }, el);
      else p.wheel({ ...wheel(full, 22.5), deltaMode: 1 });
      runFrames(2);
      assert.ok(el._glide && el.scrollTop > 0, 'gliding');
      p.op_cmd(command);
      runFrames();
      assert.equal(el.scrollTop, end, `${command[2]} after a ${key ? 'key' : 'wheel'}`);
      assert.equal(el._glide, null);
      assert.equal(el._driven, 0);
      assert.equal(el._applied, 1);
    }
  }
});

test('scroll keys tell the engine, End as End', (t) => {
  t.mock.method(performance, 'now', () => clock);
  const { p, el } = scroller();
  p.scrollKey({ key: 'End', shiftKey: false }, el);
  p.scrollKey({ key: 'PageUp', shiftKey: false }, el);
  runFrames();
  // The key's own move (3: to the end, 1: by pages): a list follows its
  // end from End on; Page Up leaves it.
  assert.deepEqual(p.keyScrolls, [[1, 3, 0], [1, 1, -1]]);
});

test('a glide moves with the content the core keeps in place', (t) => {
  t.mock.method(performance, 'now', () => clock);
  const { p, el, full } = scroller();
  p.wheel({ ...wheel(full, 22.5), deltaMode: 1 });
  runFrames(2);
  const at = el.scrollTop;
  p.op_sb(['sb', 1, 0, 100]);
  assert.equal(el.scrollTop, at + 100);
  runFrames();
  assert.equal(el.scrollTop, 1000);
  assert.equal(el._applied, 1);
  // A touchpad's scroll goes on from there too.
  const pad = scroller();
  pad.p.wheel(wheel(pad.full, 20));
  pad.p.op_sb(['sb', 1, 0, 100]);
  pad.p.wheel(wheel(pad.full, 20));
  assert.equal(pad.el.scrollTop, 140);
});

test('a scroll a command stops ends once, with or without moving', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Each from `start`, scrolled 40 down.
  const commands = [
    [['cmd', 1, 'scrollTo', 0, 40, false], 0, 40],
    [['cmd', 1, 'scrollTo', 0, 40, true], 0, 40],
    [['cmd', 1, 'scrollToEnd', false], 4760, 4800],
    [['cmd', 1, 'scrollTo', 0, 0, false], 0, 0],
  ];
  for (const [command, start, end] of commands) {
    const { p, el, full } = scroller();
    el.scrollTop = start;
    const ends = [];
    el._events.add('onScrollEnd');
    p.event = (id, name, e) => ends.push(e.y);
    // A touchpad moves the view at once; its end waits for it to settle,
    // and the browser's `scrollend` meanwhile is not the end.
    p.wheel(wheel(full, 20));
    p.wheel(wheel(full, 20));
    p.scrollEnded(el);
    const at = el.scrollTop;
    p.op_cmd(command);
    // An animated command runs out its own frames (`animateScroll`).
    runFrames();
    t.mock.timers.tick(200);
    // The browser's `scrollend` follows a scroll that moved, only then.
    if (el.scrollTop !== at) p.scrollEnded(el);
    assert.deepEqual(ends, [end], command.slice(2).join(' '));
    assert.equal(el._driven, 0);
  }
});

test('fractional scroll commands end once at the browser destination', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Commands that do not animate are the browser's scroll; animated ones
  // run their own frames and end on the last of them, below.
  for (const destination of [40, 40.5]) {
    const { p, el, full } = scroller();
    const ends = [];
    el._events.add('onScrollEnd');
    p.event = (id, name, e) => ends.push(e.y);
    p.wheel(wheel(full, 20));
    p.wheel(wheel(full, 20));
    // Model a browser that rounds to physical pixels, including a
    // destination that rounds back to the current position.
    el.scrollTo = () => { el.scrollTop = destination; };
    p.op_cmd(['cmd', 1, 'scrollTo', 0, 40.4, false]);
    assert.deepEqual(ends, []);
    if (destination !== 40) p.scrollEnded(el);
    t.mock.timers.tick(200);
    assert.deepEqual(ends, [destination]);
    if (destination === 40) {
      p.scrollEnded(el);
      assert.deepEqual(ends, [destination]);
    }
  }
});

test('an animated command lands in its own time, whatever the distance', (t) => {
  t.mock.method(performance, 'now', () => clock);
  const { p, el } = scroller();
  p.call = () => {};
  const ends = [];
  el._events.add('onScrollEnd');
  p.event = (id, name, e) => ends.push(e.y);
  el.scrollTop = 2500;
  const started = clock;
  p.op_cmd(['cmd', 1, 'scrollTo', 0, 0, true]);
  // It moves on its frames, not by handing the scroll to the browser.
  assert.equal(el.scrollTop, 2500);
  assert.equal(el._driven, 1);
  runFrames(1);
  assert.ok(el.scrollTop < 2500 && el.scrollTop > 2000, `moved to ${el.scrollTop}`);
  runFrames();
  assert.equal(el.scrollTop, 0);
  assert.deepEqual(ends, [0]);
  assert.equal(el._driven, 0);
  // 300 ms, as the core's own scroll animation takes on the other
  // platforms, and a frame to pass 1.
  assert.ok(clock - started < 320, `took ${clock - started} ms`);
  // The browser's `scrollend` for the frames it drew is not another end.
  p.scrollEnded(el);
  assert.deepEqual(ends, [0]);
});

test('an animated command whose frames stop ends where it was going', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, el } = scroller();
  p.call = () => {};
  const ends = [];
  el._events.add('onScrollEnd');
  p.event = (id, name, e) => ends.push(e.y);
  el.scrollTop = 2500;
  p.op_cmd(['cmd', 1, 'scrollTo', 0, 0, true]);
  runFrames(2);
  // A hidden tab stops asking for frames.
  frames.clear();
  t.mock.timers.tick(600);
  assert.equal(el.scrollTop, 0);
  assert.deepEqual(ends, [0]);
  assert.equal(el._driven, 0);
});

test('the user takes over an animated command', (t) => {
  t.mock.method(performance, 'now', () => clock);
  const { p, el } = scroller();
  p.call = () => {};
  const ends = [];
  el._events.add('onScrollEnd');
  p.event = (id, name, e) => ends.push(e.y);
  el.scrollTop = 2500;
  p.op_cmd(['cmd', 1, 'scrollTo', 0, 0, true]);
  runFrames(2);
  const at = el.scrollTop;
  // `op_c` listens for these on the view; the player under test has none,
  // so take over as they do.
  p.endScrollAnimation(el, false);
  runFrames();
  assert.equal(el.scrollTop, at, 'left where the user took it over');
  assert.equal(el._driven, 0);
  assert.deepEqual(ends, [], 'the scroll goes on as the user scrolls it');
});

test('the anchoring scroll of a list does not stop the animation beside it', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, el } = scroller();
  p.call = () => {};
  const ends = [];
  el._events.add('onScrollEnd');
  p.event = (id, name, e) => ends.push(e.y);
  el.scrollTop = 2000;
  // The commit that loads a page of rows above an inverted list: it keeps
  // what shows in place, then scrolls to one of the rows it loaded.
  p.op_sb(['sb', 1, 0, 1200]);
  assert.equal(el.scrollTop, 3200);
  p.op_cmd(['cmd', 1, 'scrollTo', 0, 0, true]);
  // The browser's `scrollend` for the anchoring scroll arrives once the
  // animation beside it is under way: not its end.
  p.scrollEnded(el);
  runFrames(2);
  assert.ok(el._smooth, 'still animating');
  const at = el.scrollTop;
  // The next commit's anchoring moves the content and the animation with
  // it, so it goes on from the content it was on.
  p.op_sb(['sb', 1, 0, 400]);
  assert.equal(el.scrollTop, at + 400);
  assert.equal(el._smooth.y, 400);
  runFrames();
  assert.equal(el.scrollTop, 400);
  assert.deepEqual(ends, [400]);
});

test('a glide whose frames stop ends where it was going, once', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, el, full } = scroller();
  const ends = [];
  el._events.add('onScrollEnd');
  p.event = (id, name, e) => ends.push(e.y);
  p.call = () => {};
  p.wheel({ ...wheel(full, 22.5), deltaMode: 1 });
  runFrames(2);
  assert.ok(el._glide && el.scrollTop < 900, 'gliding');
  // No more frames (a hidden tab): its frame stays queued.
  t.mock.timers.tick(200);
  assert.deepEqual(ends, [], 'its frames have not stopped for long yet');
  clock += 400;
  t.mock.timers.tick(200);
  assert.equal(el.scrollTop, 900);
  assert.deepEqual(ends, [900]);
  assert.equal(el._glide, null);
  assert.equal(el._driven, 0);
  frames.clear();
  t.mock.timers.tick(1000);
  assert.deepEqual(ends, [900]);
});

test('a glide interrupted by direct input continues from its displayed position', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, el } = scroller();
  p.scrollSmoothly(el, 0, 900, true);
  runFrames(2);
  const at = el.scrollTop;
  p.scrollSmoothly(el, 0, 0.25, false);
  assert.equal(el.scrollTop, at + 0.25, 'no accumulated destination is applied');
  runFrames();
  assert.equal(el.scrollTop, at + 0.25, 'cancelled frames cannot catch up');
  t.mock.timers.tick(200);
  assert.equal(el._driven, 0);
});

test('pixel-mode inertia crosses 40 without starting or cancelling a glide', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, el, full } = scroller();
  let total = 0;
  for (const d of [120, 80, 40, 39, 20, 5, 1, 0.25]) {
    p.wheel(wheel(full, d));
    total += d;
    assert.equal(el.scrollTop, total);
    assert.equal(el._glide.frame, 0, 'the device already supplies inertia');
    runFrames(2);
  }
  t.mock.timers.tick(200);
  assert.equal(el._driven, 0);
});

test('a view listening to onWheel inside a scroll view takes the wheel', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, el } = scroller();
  const sent = [];
  p.event = (id, name, payload) => sent.push([id, name, payload]);
  p.point = (e) => [e.clientX, e.clientY];
  const canvas = {
    _id: 2, _kind: 'view', _events: new Set(['onWheel']), parentNode: el,
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
  };
  p.views.set(2, canvas);
  p.wheelTracked = new Set([2]);
  let prevented = false;
  const e = { deltaMode: 1, deltaX: 0, deltaY: -3, clientX: 15, clientY: 30, ctrlKey: true, target: canvas, preventDefault() { prevented = true; } };
  p.wheel(e);
  assert.equal(el.scrollTop, 0, 'the scroll view around does not scroll');
  assert.ok(prevented);
  assert.deepEqual(sent, [[2, 'onWheel', {
    position: { x: 5, y: 10 }, pagePosition: { x: 15, y: 30 }, delta: { x: 0, y: -3 }, deltaMode: 'lines',
    modifiers: { control: true, alt: undefined, shift: undefined, platform: undefined },
  }]]);
  // The scroll view itself listening only observes: it still scrolls (the
  // browser does).
  sent.length = 0;
  canvas._events = new Set();
  el._events = new Set(['onWheel']);
  el.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const own = { ...tracked(el, 20), clientX: 0, clientY: 0 };
  p.wheel(own);
  assert.equal(sent.length, 1);
  assert.equal(own.prevented, false);
  assert.equal(p.wheelLock.el, el);
});

test('one scroll stays on the view that took it, and a scroll going on is only observed', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, el } = scroller();
  const sent = [];
  p.event = (id, name, payload) => sent.push([id, name, payload]);
  p.point = (e) => [e.clientX, e.clientY];
  const canvas = {
    _id: 2, _kind: 'view', _events: new Set(['onWheel']), parentNode: el, isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  p.views.set(2, canvas);
  p.wheelTracked = new Set([2]);
  const notch = (target, dy) => ({ deltaMode: 1, deltaX: 0, deltaY: dy, clientX: 0, clientY: 0, target, preventDefault() {} });
  // A notch over the canvas: it takes it.
  p.wheel(notch(canvas, 3));
  assert.equal(sent.at(-1)[0], 2);
  assert.equal(el.scrollTop, 0);
  // The next one comes over the scroll view itself: still the canvas's.
  clock += 50;
  p.wheel(notch(el, 3));
  assert.equal(sent.length, 2);
  assert.equal(sent.at(-1)[0], 2);
  assert.equal(el.scrollTop, 0, 'the scroll view did not take over');
  // After a pause a touchpad scrolls the scroll view; when the canvas
  // comes under the pointer while that scroll goes on, it only observes it.
  el.isConnected = true;
  clock += 300;
  const pad = tracked(el, 20);
  p.wheel(pad);
  assert.equal(pad.prevented, false, 'the browser scrolls it');
  assert.equal(p.wheelLock.el, el);
  clock += 50;
  const over = tracked(canvas, 20);
  p.wheel(over);
  assert.equal(sent.at(-1)[0], 2);
  assert.equal(over.prevented, false, 'the scroll view kept scrolling');
});

test('a wheel the browser would scroll the same way is its own', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const scrollend of [true, false]) {
    const { p, el } = scroller();
    const ends = [];
    el._events.add('onScrollEnd');
    p.event = (id, name, e) => ends.push(e.y);
    // A mouse notch as Chrome and Safari send it: pixels.
    const e = tracked(el, 4);
    p.wheel(e);
    assert.equal(e.prevented, false, 'the browser scrolls it, with its own glide');
    assert.equal(el._glide ?? null, null);
    assert.equal(el._driven ?? 0, 0);
    // Its frames move the view; each keeps the end waiting. A second notch
    // soon after, with the browser's `scrollend` for the first between
    // them, is the same scroll.
    for (const y of [1, 2, 4]) {
      t.mock.timers.tick(50);
      el.scrollTop = y;
      p.scrolled(el);
      if (y === 2) {
        p.scrollEnded(el);
        p.wheel(tracked(el, 2));
      }
    }
    assert.deepEqual(ends, []);
    clock += 300;
    if (scrollend) p.scrollEnded(el);
    else t.mock.timers.tick(200);
    assert.deepEqual(ends, [4], scrollend ? 'the browser\'s scrollend' : 'no scrollend: 200 ms after the last move');
    // Neither the fallback after the browser's end nor a late `scrollend`
    // after the fallback's is another.
    t.mock.timers.tick(1000);
    if (!scrollend) p.scrollEnded(el);
    assert.deepEqual(ends, [4], 'once');
  }
});

test('a key glide a browser wheel interrupts stops where it is', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, el } = scroller();
  p.call = () => {};
  const ends = [];
  el._events.add('onScrollEnd');
  p.event = (id, name, e) => ends.push(e.y);
  p.scrollKey({ key: 'PageDown', shiftKey: false }, el);
  runFrames(2);
  const at = el.scrollTop;
  assert.ok(el._glide && at > 0, 'gliding');
  p.wheel(tracked(el, 4));
  assert.equal(el._glide, null);
  assert.equal(el._driven, 0);
  runFrames();
  assert.equal(el.scrollTop, at, 'its frames do not put the view back');
  assert.deepEqual(ends, [], 'the wheel goes on from there');
  clock += 200;
  t.mock.timers.tick(200);
  assert.deepEqual(ends, [at]);
});

test('nsh scrolls the wheels the browser would not scroll the same way', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // An outer view, past an inner one at its end.
  const outer = scroller();
  const e = tracked(outer.full, 40);
  outer.p.wheel(e);
  assert.ok(e.prevented);
  assert.equal(outer.el.scrollTop, 40);
  // A snapping view: one snap point per scroll.
  const snapping = scroller();
  snapping.el._snapPoints = [0, 200, 400];
  let stepped = 0;
  snapping.p.snapStep = () => stepped++;
  const s = tracked(snapping.el, 40);
  snapping.p.wheel(s);
  assert.ok(s.prevented);
  assert.equal(stepped, 1);
  // A content layer (zoom, pull to refresh): its offsets are nsh's.
  const layered = scroller();
  layered.el._layer = {};
  const l = tracked(layered.el, 40);
  layered.p.wheel(l);
  assert.ok(l.prevented);
  assert.equal(layered.el.scrollTop, 40);
  // A vertical wheel on a horizontal view no vertical one takes.
  const sideways = scroller();
  Object.assign(sideways.el, { _horizontal: true, scrollWidth: 5000, scrollHeight: 200 });
  sideways.p.views.delete(3);
  const h = tracked(sideways.el, 40);
  sideways.p.wheel(h);
  assert.ok(h.prevented);
  assert.equal(sideways.el.scrollLeft, 40);
});

test('onPinch hears a Safari touchpad pinch from its start to its end', (t) => {
  const { p, el } = scroller();
  const sent = [];
  p.event = (id, name, payload) => sent.push([id, name, payload]);
  p.point = (e) => [e.clientX, e.clientY];
  const canvas = {
    _id: 2, _kind: 'view', _events: new Set(['onPinch']), parentNode: el, isConnected: true,
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
  };
  const other = { _id: 4, _kind: 'view', _events: new Set(), parentNode: el, isConnected: true };
  p.views.set(2, canvas);
  p.views.set(4, other);
  let prevented = 0;
  const gesture = (target, scale) => ({ target, scale, clientX: 15, clientY: 30, preventDefault() { prevented++; } });
  assert.ok(p.pinchEvent(gesture(canvas, 1), 0), 'the canvas takes the pinch');
  assert.ok(p.pinchEvent(gesture(other, 1.5), 1), 'it stays on the canvas');
  assert.ok(p.pinchEvent(gesture(other, 1.2), 2));
  assert.equal(prevented, 3);
  assert.deepEqual(sent.map(([id, name, e]) => [id, name, e.phase, Math.round(e.delta * 100) / 100]), [
    [2, 'onPinch', 'start', 0], [2, 'onPinch', 'move', 0.5], [2, 'onPinch', 'end', 0],
  ]);
  assert.deepEqual(sent[1][2].position, { x: 5, y: 10 });
  // Over no listener the scroll view's own zoom handles it.
  assert.ok(!p.pinchEvent(gesture(other, 1), 0));
});
