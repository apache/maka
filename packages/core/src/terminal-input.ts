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

export type TerminalInputNamedKey = (typeof TERMINAL_INPUT_NAMED_KEYS)[number];
export type TerminalInputModifier = (typeof TERMINAL_INPUT_MODIFIERS)[number];

export interface TerminalTextInputAction {
  readonly type: 'text';
  readonly text: string;
}

export interface TerminalKeyInputAction {
  readonly type: 'key';
  readonly key: TerminalInputNamedKey | string;
  readonly modifiers?: readonly TerminalInputModifier[];
}

export type TerminalInputAction = TerminalTextInputAction | TerminalKeyInputAction;

export interface TerminalInputModes {
  readonly applicationCursorKeysMode: boolean;
}

const NAMED_KEY_SET = new Set<string>(TERMINAL_INPUT_NAMED_KEYS);
const MODIFIER_SET = new Set<string>(TERMINAL_INPUT_MODIFIERS);

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
  if (action.type !== 'key') throw new Error('Terminal input action type must be text or key');
  assertOnlyActionFields(action, ['type', 'key', 'modifiers']);
  if (typeof action.key !== 'string') throw new Error('Terminal key must be a string');
  if (!isTerminalInputNamedKey(action.key) && !isTerminalCharacterKey(action.key)) {
    throw new Error('Terminal key must be a supported named key or printable ASCII character');
  }
  if (action.modifiers !== undefined && !Array.isArray(action.modifiers)) {
    throw new Error('Terminal key modifiers must be an array');
  }
  const modifiers = action.modifiers as unknown[] | undefined;
  if (
    modifiers?.some(
      (modifier) => typeof modifier !== 'string' || !isTerminalInputModifier(modifier),
    )
  ) {
    throw new Error('Terminal key modifier is not supported');
  }
  if (modifiers && new Set(modifiers).size !== modifiers.length) {
    throw new Error('Terminal key modifiers must be unique');
  }
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
  } else if (normalized.type === 'key') {
    if (normalized.text === '' || normalized.text === null) delete normalized.text;
  }
  if (normalized.modifiers === null || isEmptyArray(normalized.modifiers)) {
    delete normalized.modifiers;
  }
  return normalized;
}

export function encodeTerminalInputActions(
  actions: readonly TerminalInputAction[],
  modes: TerminalInputModes,
): string {
  return actions.map((action) => encodeTerminalInputAction(action, modes)).join('');
}

export function formatTerminalInputActions(actions: readonly TerminalInputAction[]): string {
  return actions.map(formatTerminalInputAction).join(' → ');
}

function encodeTerminalInputAction(action: TerminalInputAction, modes: TerminalInputModes): string {
  if (action.type === 'text') return action.text;
  const modifiers = new Set(action.modifiers ?? []);
  if (isTerminalInputNamedKey(action.key)) {
    return encodeNamedKey(action.key, modifiers, modes);
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
