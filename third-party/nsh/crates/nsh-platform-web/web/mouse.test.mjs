import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
const { Player } = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64'));

test('mouse motion visits nested listeners inside out, including with buttons down, with MouseEvent payloads', () => {
  const root = { parentNode: null, contains: (el) => el === child };
  const outer = { _id: 2, parentNode: root, _events: new Set(['onMouseMove']), getBoundingClientRect: () => ({ left: 10, top: 20 }) };
  const child = { _id: 3, parentNode: outer, _events: new Set(['onMouseMove']), getBoundingClientRect: () => ({ left: 30, top: 50 }) };
  globalThis.document = { elementFromPoint: () => child };
  globalThis.getComputedStyle = () => ({ transform: 'none', width: '100px', height: '100px' });
  const player = Object.create(Player.prototype);
  player.root = root;
  player.mouseTracked = new Set([2, 3]);
  const sent = [];
  player.event = (...args) => sent.push(args);
  player.point = (e) => [e.clientX, e.clientY];
  const modifiers = { control: false, alt: false, shift: true, platform: false };
  const mouse = (x, y, pressedButton) => ({ position: { x, y }, pagePosition: { x: 45, y: 75 }, modifiers, pressedButton });
  const event = { pointerType: 'mouse', clientX: 45, clientY: 75, buttons: 1, shiftKey: true, target: outer };
  player.mouseMoved(event);
  assert.deepEqual(sent, [[3, 'onMouseMove', mouse(15, 25, 'left')], [2, 'onMouseMove', mouse(35, 55, 'left')]]);
  sent.length = 0;
  child._events.clear();
  player.mouseMoved({ ...event, buttons: 0 });
  assert.deepEqual(sent, [[2, 'onMouseMove', mouse(35, 55, null)]]);
  sent.length = 0;
  // The first button held names it: right and middle together are right.
  player.mouseMoved({ ...event, buttons: 6 });
  assert.deepEqual(sent, [[2, 'onMouseMove', mouse(35, 55, 'right')]]);
  sent.length = 0;
  for (const pointerType of ['touch', 'pen']) player.mouseMoved({ ...event, pointerType });
  assert.equal(sent.length, 0);
  player.mouseTracked.clear();
  document.elementFromPoint = () => { throw Error('unneeded hit test'); };
  player.mouseMoved(event);
  player.mouseTracked.add(2);
  document.elementFromPoint = () => null;
  player.mouseMoved(event);
  document.elementFromPoint = () => ({});
  player.mouseMoved(event);
  assert.equal(sent.length, 0, 'capture outside the player dispatches no move');
  delete globalThis.document;
  delete globalThis.getComputedStyle;
});

test('entering and leaving carry the mouse where it is, and a modifier key moves the mouse where it rests', () => {
  const root = { parentNode: null, contains: () => true };
  const listeners = {};
  const view = {
    _id: 4, parentNode: root, _events: new Set(['onMouseEnter', 'onMouseLeave', 'onMouseMove']),
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    addEventListener: (type, f) => (listeners[type] = f),
  };
  globalThis.document = { elementFromPoint: () => view };
  globalThis.getComputedStyle = () => ({ transform: 'none', width: '100px', height: '100px' });
  const player = Object.create(Player.prototype);
  player.root = root;
  player.mouseTracked = new Set([4]);
  const sent = [];
  player.event = (...args) => sent.push(args);
  player.point = (e) => [e.clientX, e.clientY];
  const none = { control: false, alt: false, shift: false, platform: false };
  const mouse = (x, y, modifiers = none, pressedButton = null) =>
    ({ position: { x: x - 10, y: y - 20 }, pagePosition: { x, y }, modifiers, pressedButton });
  player.installMouse(view);
  // Touches neither enter nor leave.
  listeners.pointerenter({ pointerType: 'touch', clientX: 15, clientY: 25, buttons: 1 });
  listeners.pointerleave({ pointerType: 'touch', clientX: 15, clientY: 25, buttons: 0 });
  assert.equal(sent.length, 0);
  listeners.pointerenter({ pointerType: 'mouse', clientX: 15, clientY: 25, buttons: 4 });
  assert.deepEqual(sent, [[4, 'onMouseEnter', mouse(15, 25, none, 'middle')]]);
  sent.length = 0;
  // Resting there, Shift goes down: a move where it is, with Shift.
  player.hover = [30, 40];
  player.hoverButtons = 0;
  player.modifiersChanged({ key: 'Shift', shiftKey: true });
  assert.deepEqual(sent, [[4, 'onMouseMove', mouse(30, 40, { ...none, shift: true })]]);
  sent.length = 0;
  // Not while a button is down, nor for other keys or repeats.
  player.hoverButtons = 1;
  player.modifiersChanged({ key: 'Shift', shiftKey: true });
  player.hoverButtons = 0;
  player.modifiersChanged({ key: 'a' });
  player.modifiersChanged({ key: 'Shift', shiftKey: true, repeat: true });
  assert.equal(sent.length, 0);
  listeners.pointerleave({ pointerType: 'mouse', clientX: 5, clientY: 50, buttons: 0 });
  assert.deepEqual(sent, [[4, 'onMouseLeave', mouse(5, 50)]]);
  sent.length = 0;
  // Once it left, a modifier key moves nothing there.
  player.modifiersChanged({ key: 'Shift', shiftKey: false });
  assert.equal(sent.length, 0);
  delete globalThis.document;
  delete globalThis.getComputedStyle;
});
