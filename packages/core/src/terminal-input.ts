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

export const TERMINAL_INPUT_NAMED_KEYS = [
  'enter',
  'escape',
  'tab',
  'backspace',
  'delete',
  'arrow_up',
  'arrow_down',
  'arrow_left',
  'arrow_right',
  'home',
  'end',
  'insert',
  'page_up',
  'page_down',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
] as const;

export const TERMINAL_INPUT_MODIFIERS = ['ctrl', 'alt', 'shift'] as const;
export const TERMINAL_MOUSE_BUTTONS = ['left', 'middle', 'right'] as const;
export const TERMINAL_MOUSE_EVENTS = ['click', 'press', 'release', 'move', 'scroll'] as const;
export const TERMINAL_MOUSE_SCROLL_DIRECTIONS = ['up', 'down'] as const;

export type TerminalInputNamedKey = (typeof TERMINAL_INPUT_NAMED_KEYS)[number];
export type TerminalInputModifier = (typeof TERMINAL_INPUT_MODIFIERS)[number];
export type TerminalMouseButton = (typeof TERMINAL_MOUSE_BUTTONS)[number];
export type TerminalMouseEvent = (typeof TERMINAL_MOUSE_EVENTS)[number];
export type TerminalMouseScrollDirection = (typeof TERMINAL_MOUSE_SCROLL_DIRECTIONS)[number];
export type TerminalMouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';
export type TerminalMouseEncoding = 'default' | 'sgr' | 'sgr_pixels';

export interface TerminalTextInputAction {
  readonly type: 'text';
  readonly text: string;
}

export interface TerminalKeyInputAction {
  readonly type: 'key';
  readonly key: TerminalInputNamedKey | string;
  readonly modifiers?: readonly TerminalInputModifier[];
}

interface TerminalMouseInputActionBase {
  readonly type: 'mouse';
  readonly x: number;
  readonly y: number;
  readonly modifiers?: readonly TerminalInputModifier[];
}

export type TerminalMouseInputAction =
  | (TerminalMouseInputActionBase & {
      readonly event: 'click' | 'press' | 'release';
      readonly button: TerminalMouseButton;
      readonly direction?: never;
    })
  | (TerminalMouseInputActionBase & {
      readonly event: 'move';
      readonly button?: TerminalMouseButton;
      readonly direction?: never;
    })
  | (TerminalMouseInputActionBase & {
      readonly event: 'scroll';
      readonly button?: never;
      readonly direction: TerminalMouseScrollDirection;
    });

export type TerminalInputAction =
  | TerminalTextInputAction
  | TerminalKeyInputAction
  | TerminalMouseInputAction;

export interface TerminalInputModes {
  readonly applicationCursorKeysMode: boolean;
}

export interface TerminalInputState extends TerminalInputModes {
  readonly mouseTrackingMode: TerminalMouseTrackingMode;
  readonly mouseEncoding: TerminalMouseEncoding;
  readonly cols: number;
  readonly rows: number;
}

const NAMED_KEY_SET = new Set<string>(TERMINAL_INPUT_NAMED_KEYS);
const MODIFIER_SET = new Set<string>(TERMINAL_INPUT_MODIFIERS);
const MOUSE_BUTTON_SET = new Set<string>(TERMINAL_MOUSE_BUTTONS);
const MOUSE_EVENT_SET = new Set<string>(TERMINAL_MOUSE_EVENTS);
const MOUSE_SCROLL_DIRECTION_SET = new Set<string>(TERMINAL_MOUSE_SCROLL_DIRECTIONS);

export function isTerminalInputNamedKey(value: string): value is TerminalInputNamedKey {
  return NAMED_KEY_SET.has(value);
}

export function isTerminalInputModifier(value: string): value is TerminalInputModifier {
  return MODIFIER_SET.has(value);
}

export function isTerminalCharacterKey(value: string): boolean {
  return value.length === 1 && value.charCodeAt(0) >= 0x20 && value.charCodeAt(0) <= 0x7e;
}

export function isWellFormedTerminalInput(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function parseTerminalInputAction(value: unknown): TerminalInputAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Terminal input action must be an object');
  }
  const action = value as Record<string, unknown>;
  if (action.type === 'text') {
    assertOnlyActionFields(action, ['type', 'text']);
    if (typeof action.text !== 'string' || action.text.length === 0) {
      throw new Error('Terminal text action must contain text');
    }
    if (!isWellFormedTerminalInput(action.text)) {
      throw new Error('Terminal text action must be well-formed Unicode');
    }
    if (hasTerminalControlCharacter(action.text)) {
      throw new Error('Terminal text action cannot contain terminal control characters');
    }
    return { type: 'text', text: action.text };
  }
  if (action.type === 'mouse') return parseMouseAction(action);
  if (action.type !== 'key') {
    throw new Error('Terminal input action type must be text, key, or mouse');
  }
  assertOnlyActionFields(action, ['type', 'key', 'modifiers']);
  if (typeof action.key !== 'string') throw new Error('Terminal key must be a string');
  if (!isTerminalInputNamedKey(action.key) && !isTerminalCharacterKey(action.key)) {
    throw new Error('Terminal key must be a supported named key or printable ASCII character');
  }
  const modifiers = parseModifiers(action.modifiers, 'key');
  const parsed: TerminalKeyInputAction = {
    type: 'key',
    key: action.key,
    ...(modifiers && modifiers.length > 0
      ? { modifiers: modifiers as TerminalInputModifier[] }
      : {}),
  };
  encodeTerminalInputAction(parsed, { applicationCursorKeysMode: false });
  return parsed;
}

export function normalizeTerminalInputActionDefaults(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const normalized = { ...(value as Record<string, unknown>) };
  if (normalized.type === 'text') {
    if (normalized.key === '' || normalized.key === null) delete normalized.key;
    deleteProviderDefaults(normalized, ['event', 'x', 'y', 'button', 'direction']);
  } else if (normalized.type === 'key') {
    if (normalized.text === '' || normalized.text === null) delete normalized.text;
    deleteProviderDefaults(normalized, ['event', 'x', 'y', 'button', 'direction']);
  } else if (normalized.type === 'mouse') {
    deleteProviderDefaults(normalized, ['text', 'key']);
    if (normalized.event === 'scroll') deleteProviderDefaults(normalized, ['button']);
    else deleteProviderDefaults(normalized, ['direction']);
  }
  if (normalized.modifiers === null || isEmptyArray(normalized.modifiers)) {
    delete normalized.modifiers;
  }
  return normalized;
}

export function encodeTerminalInputActions(
  actions: readonly TerminalInputAction[],
  state: TerminalInputModes | TerminalInputState,
): string {
  return actions.map((action) => encodeTerminalInputAction(action, state)).join('');
}

export function encodedTerminalInputActionsByteLength(
  actions: readonly TerminalInputAction[],
): number {
  const encoded = actions
    .map((action) => {
      if (action.type === 'mouse') return encodeSgrTerminalMouseInputAction(action);
      return encodeTerminalInputAction(action, { applicationCursorKeysMode: false });
    })
    .join('');
  return new TextEncoder().encode(encoded).byteLength;
}

export function formatTerminalInputActions(actions: readonly TerminalInputAction[]): string {
  return actions.map(formatTerminalInputAction).join(' → ');
}

function encodeTerminalInputAction(
  action: TerminalInputAction,
  state: TerminalInputModes | TerminalInputState,
): string {
  if (action.type === 'text') return action.text;
  if (action.type === 'mouse') {
    return encodeTerminalMouseInputAction(action, requireTerminalInputState(state));
  }
  const modifiers = new Set(action.modifiers ?? []);
  if (isTerminalInputNamedKey(action.key)) {
    return encodeNamedKey(action.key, modifiers, state);
  }
  return encodeCharacterKey(action.key, modifiers);
}

function encodeCharacterKey(key: string, modifiers: ReadonlySet<TerminalInputModifier>): string {
  if (!isTerminalCharacterKey(key)) throw new Error(`Unsupported terminal character key: ${key}`);
  if (modifiers.has('shift')) {
    throw new Error('Use the shifted character directly instead of the shift modifier');
  }
  let encoded = modifiers.has('ctrl') ? encodeCtrlCharacter(key) : key;
  if (modifiers.has('alt')) encoded = `\u001b${encoded}`;
  return encoded;
}

function encodeCtrlCharacter(key: string): string {
  const code = key.charCodeAt(0);
  if (key === ' ' || key === '@') return '\u0000';
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
    return String.fromCharCode(code & 0x1f);
  }
  switch (key) {
    case '[':
      return '\u001b';
    case '\\':
      return '\u001c';
    case ']':
      return '\u001d';
    case '^':
      return '\u001e';
    case '_':
      return '\u001f';
    case '?':
      return '\u007f';
    default:
      throw new Error(`Ctrl-${key} has no portable terminal encoding`);
  }
}

function encodeNamedKey(
  key: TerminalInputNamedKey,
  modifiers: ReadonlySet<TerminalInputModifier>,
  modes: TerminalInputModes,
): string {
  if (modifiers.size === 0) return unmodifiedNamedKey(key, modes);
  if (key === 'tab' && modifiers.size === 1 && modifiers.has('shift')) return '\u001b[Z';
  if (['enter', 'escape', 'tab', 'backspace'].includes(key)) {
    throw new Error(`${formatNamedKey(key)} does not support these modifiers`);
  }

  const parameter = xtermModifierParameter(modifiers);
  const final = cursorKeyFinal(key);
  if (final) return `\u001b[1;${parameter}${final}`;
  const tilde = tildeKeyParameter(key);
  if (tilde !== undefined) return `\u001b[${tilde};${parameter}~`;
  const functionFinal = functionKeyFinal(key);
  if (functionFinal) return `\u001b[1;${parameter}${functionFinal}`;
  throw new Error(`Unsupported modified terminal key: ${key}`);
}

function unmodifiedNamedKey(key: TerminalInputNamedKey, modes: TerminalInputModes): string {
  switch (key) {
    case 'enter':
      return '\r';
    case 'escape':
      return '\u001b';
    case 'tab':
      return '\t';
    case 'backspace':
      return '\u007f';
  }
  const final = cursorKeyFinal(key);
  if (final) return `\u001b${modes.applicationCursorKeysMode ? 'O' : '['}${final}`;
  const tilde = tildeKeyParameter(key);
  if (tilde !== undefined) return `\u001b[${tilde}~`;
  const functionFinal = functionKeyFinal(key);
  if (functionFinal) return `\u001bO${functionFinal}`;
  throw new Error(`Unsupported terminal key: ${key}`);
}

function cursorKeyFinal(key: TerminalInputNamedKey): string | undefined {
  switch (key) {
    case 'arrow_up':
      return 'A';
    case 'arrow_down':
      return 'B';
    case 'arrow_right':
      return 'C';
    case 'arrow_left':
      return 'D';
    case 'home':
      return 'H';
    case 'end':
      return 'F';
    default:
      return undefined;
  }
}

function tildeKeyParameter(key: TerminalInputNamedKey): number | undefined {
  switch (key) {
    case 'insert':
      return 2;
    case 'delete':
      return 3;
    case 'page_up':
      return 5;
    case 'page_down':
      return 6;
    case 'f5':
      return 15;
    case 'f6':
      return 17;
    case 'f7':
      return 18;
    case 'f8':
      return 19;
    case 'f9':
      return 20;
    case 'f10':
      return 21;
    case 'f11':
      return 23;
    case 'f12':
      return 24;
    default:
      return undefined;
  }
}

function functionKeyFinal(key: TerminalInputNamedKey): string | undefined {
  switch (key) {
    case 'f1':
      return 'P';
    case 'f2':
      return 'Q';
    case 'f3':
      return 'R';
    case 'f4':
      return 'S';
    default:
      return undefined;
  }
}

function xtermModifierParameter(modifiers: ReadonlySet<TerminalInputModifier>): number {
  return (
    1 +
    (modifiers.has('shift') ? 1 : 0) +
    (modifiers.has('alt') ? 2 : 0) +
    (modifiers.has('ctrl') ? 4 : 0)
  );
}

function formatTerminalInputAction(action: TerminalInputAction): string {
  if (action.type === 'text') return JSON.stringify(action.text);
  if (action.type === 'mouse') return formatTerminalMouseInputAction(action);
  const key = isTerminalInputNamedKey(action.key)
    ? formatNamedKey(action.key)
    : action.key.toUpperCase();
  const modifiers = new Set(action.modifiers ?? []);
  const prefix = [
    ...(modifiers.has('ctrl') ? ['Ctrl'] : []),
    ...(modifiers.has('alt') ? ['Alt'] : []),
    ...(modifiers.has('shift') ? ['Shift'] : []),
  ];
  return [...prefix, key].join('-');
}

function parseMouseAction(action: Record<string, unknown>): TerminalMouseInputAction {
  assertOnlyActionFields(action, ['type', 'event', 'x', 'y', 'button', 'direction', 'modifiers']);
  if (typeof action.event !== 'string' || !MOUSE_EVENT_SET.has(action.event)) {
    throw new Error('Terminal mouse event is not supported');
  }
  if (!Number.isSafeInteger(action.x) || (action.x as number) < 0) {
    throw new Error('Terminal mouse x must be a non-negative integer');
  }
  if (!Number.isSafeInteger(action.y) || (action.y as number) < 0) {
    throw new Error('Terminal mouse y must be a non-negative integer');
  }
  const event = action.event as TerminalMouseEvent;
  const button = parseMouseButton(action.button);
  const direction = parseMouseDirection(action.direction);
  const modifiers = parseModifiers(action.modifiers, 'mouse');
  const base = {
    type: 'mouse',
    x: action.x as number,
    y: action.y as number,
    ...(modifiers && modifiers.length > 0 ? { modifiers } : {}),
  } as const;
  if (event === 'scroll') {
    if (!direction) throw new Error('Terminal mouse scroll requires a direction');
    if (button) throw new Error('Terminal mouse scroll does not accept a button');
    return { ...base, event, direction };
  }
  if (direction) throw new Error(`Terminal mouse ${event} does not accept a direction`);
  if (event === 'move') return { ...base, event, ...(button ? { button } : {}) };
  if (!button) throw new Error(`Terminal mouse ${event} requires a button`);
  return { ...base, event, button };
}

function parseModifiers(
  value: unknown,
  actionKind: 'key' | 'mouse',
): TerminalInputModifier[] | undefined {
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error(`Terminal ${actionKind} modifiers must be an array`);
  }
  const modifiers = value as unknown[] | undefined;
  if (
    modifiers?.some(
      (modifier) => typeof modifier !== 'string' || !isTerminalInputModifier(modifier),
    )
  ) {
    throw new Error(`Terminal ${actionKind} modifier is not supported`);
  }
  if (modifiers && new Set(modifiers).size !== modifiers.length) {
    throw new Error(`Terminal ${actionKind} modifiers must be unique`);
  }
  return modifiers as TerminalInputModifier[] | undefined;
}

function parseMouseButton(value: unknown): TerminalMouseButton | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !MOUSE_BUTTON_SET.has(value)) {
    throw new Error('Terminal mouse button is not supported');
  }
  return value as TerminalMouseButton;
}

function parseMouseDirection(value: unknown): TerminalMouseScrollDirection | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !MOUSE_SCROLL_DIRECTION_SET.has(value)) {
    throw new Error('Terminal mouse scroll direction is not supported');
  }
  return value as TerminalMouseScrollDirection;
}

function requireTerminalInputState(
  state: TerminalInputModes | TerminalInputState,
): TerminalInputState {
  if (
    !('mouseTrackingMode' in state) ||
    !('mouseEncoding' in state) ||
    !('cols' in state) ||
    !('rows' in state)
  ) {
    throw new Error('Terminal mouse input requires live terminal state');
  }
  return state;
}

function formatNamedKey(key: TerminalInputNamedKey): string {
  switch (key) {
    case 'arrow_up':
      return 'Up';
    case 'arrow_down':
      return 'Down';
    case 'arrow_left':
      return 'Left';
    case 'arrow_right':
      return 'Right';
    case 'page_up':
      return 'PageUp';
    case 'page_down':
      return 'PageDown';
    default:
      return key.length === 2 && key.startsWith('f')
        ? key.toUpperCase()
        : `${key[0]?.toUpperCase()}${key.slice(1)}`;
  }
}

function assertOnlyActionFields(
  action: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const unsupported = Object.keys(action).find((field) => !allowed.includes(field));
  if (unsupported) throw new Error(`Terminal input action has unsupported field: ${unsupported}`);
}

function deleteProviderDefaults(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (value[field] === '' || value[field] === null || value[field] === 0) delete value[field];
  }
}

function hasTerminalControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function isEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0;
}
import {
  encodeSgrTerminalMouseInputAction,
  encodeTerminalMouseInputAction,
  formatTerminalMouseInputAction,
} from './terminal-mouse-input.js';
