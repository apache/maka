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

/** A vertical scroll view 300 × 200 with content 5000 tall, at the top. */
function scroller() {
  const p = Object.create(Player.prototype);
  p.root = { parentNode: null };
  p.size = [300, 200];
  // A scroll that ends tells the engine (`nsh_scroll_ended`), which these
  // players run without; -1: the engine is not due again (`schedule`).
  p.wasm = { nsh_scroll_ended: () => -1 };
  const el = {
    _id: 1, _kind: 'scroll', _events: new Set(), _applied: 0, parentNode: p.root,
    clientWidth: 300, clientHeight: 200, scrollWidth: 300, scrollHeight: 5000, scrollLeft: 0, scrollTop: 0,
    scrollTo({ left, top }) {
      this.scrollLeft = Math.min(Math.max(left, 0), this.scrollWidth - this.clientWidth);
      this.scrollTop = Math.min(Math.max(top, 0), this.scrollHeight - this.clientHeight);
    },
  };
  p.views = new Map([[1, el]]);
  return { p, el };
}
const wheel = (el, deltaY) => ({ deltaMode: 0, deltaX: 0, deltaY, target: el, preventDefault() {} });

test('scroll commands win over a wheel or key glide', (t) => {
  t.mock.method(performance, 'now', () => clock);
  const commands = [
    [['cmd', 1, 'scrollTo', 0, 0, false], 0],
    [['cmd', 1, 'scrollTo', 0, 0, true], 0],
    [['cmd', 1, 'scrollToEnd', false], 4800],
  ];
  for (const key of [false, true]) {
    for (const [command, end] of commands) {
      const { p, el } = scroller();
      if (key) p.scrollKey({ key: 'PageDown', shiftKey: false }, el);
      else p.wheel(wheel(el, 900));
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

test('a glide moves with the content the core keeps in place', (t) => {
  t.mock.method(performance, 'now', () => clock);
  const { p, el } = scroller();
  p.wheel(wheel(el, 900));
  runFrames(2);
  const at = el.scrollTop;
  p.op_sb(['sb', 1, 0, 100]);
  assert.equal(el.scrollTop, at + 100);
  runFrames();
  assert.equal(el.scrollTop, 1000);
  assert.equal(el._applied, 1);
  // A touchpad's scroll goes on from there too.
  const pad = scroller();
  pad.p.wheel(wheel(pad.el, 20));
  pad.p.op_sb(['sb', 1, 0, 100]);
  pad.p.wheel(wheel(pad.el, 20));
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
    const { p, el } = scroller();
    el.scrollTop = start;
    const ends = [];
    el._events.add('onScrollEnd');
    p.event = (id, name, e) => ends.push(e.y);
    // A touchpad moves the view at once; its end waits for it to settle,
    // and the browser's `scrollend` meanwhile is not the end.
    p.wheel(wheel(el, 20));
    p.wheel(wheel(el, 20));
    p.scrollEnded(el);
    const at = el.scrollTop;
    p.op_cmd(command);
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
  for (const animated of [false, true]) {
    for (const destination of [40, 40.5]) {
      const { p, el } = scroller();
      const ends = [];
      el._events.add('onScrollEnd');
      p.event = (id, name, e) => ends.push(e.y);
      p.wheel(wheel(el, 20));
      p.wheel(wheel(el, 20));
      // Model a browser that rounds to physical pixels, including a
      // destination that rounds back to the current position.
      el.scrollTo = () => { el.scrollTop = destination; };
      p.op_cmd(['cmd', 1, 'scrollTo', 0, 40.4, animated]);
      assert.deepEqual(ends, []);
      if (destination !== 40) p.scrollEnded(el);
      t.mock.timers.tick(200);
      assert.deepEqual(ends, [destination]);
      if (destination === 40) {
        p.scrollEnded(el);
        assert.deepEqual(ends, [destination]);
      }
    }
  }
});

test('the command end fallback waits while a smooth scroll moves', (t) => {
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, el } = scroller();
  const ends = [];
  el._events.add('onScrollEnd');
  p.event = (id, name, e) => ends.push(e.y);
  p.call = () => {};
  p.wheel(wheel(el, 20));
  p.op_cmd(['cmd', 1, 'scrollTo', 0, 400, true]);
  t.mock.timers.tick(150);
  p.scrolled(el);
  t.mock.timers.tick(150);
  assert.deepEqual(ends, []);
  p.scrollEnded(el);
  t.mock.timers.tick(200);
  assert.deepEqual(ends, [400]);
});
