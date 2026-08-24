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

import { redactSecrets } from './redaction.js';
import {
  encodedTerminalInputActionsByteLength,
  formatTerminalInputActions,
  normalizeTerminalInputActionDefaults,
  parseTerminalInputAction,
  type TerminalInputAction,
} from './terminal-input.js';

export const WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS = 160;
export const WRITE_STDIN_REF_PREVIEW_MAX_CHARS = 256;

export interface WriteStdinInputPreview {
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface WriteStdinPermissionSummary {
  ref?: {
    text: string;
    truncated: boolean;
  };
  input?: WriteStdinInputPreview;
  size?: {
    cols: number;
    rows: number;
  };
}

function escapeTerminalTextForInspection(input: string): string {
  let escaped = '"';
  for (const char of input) {
    switch (char) {
      case '\\':
        escaped += '\\\\';
        break;
      case '"':
        escaped += '\\"';
        break;
      case '\r':
        escaped += '\\r';
        break;
      case '\n':
        escaped += '\\n';
        break;
      case '\t':
        escaped += '\\t';
        break;
      case '\b':
        escaped += '\\b';
        break;
      case '\f':
        escaped += '\\f';
        break;
      default: {
        const codePoint = char.codePointAt(0) ?? 0;
        escaped +=
          codePoint < 0x20 ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
          isInvisibleCodePoint(codePoint)
            ? `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`
            : char;
      }
    }
  }
  return `${escaped}"`;
}

export function projectWriteStdinPermissionSummary(args: unknown): WriteStdinPermissionSummary {
  const parsed = readWriteStdinArgs(args);
  if (!parsed) return {};
  const summary: WriteStdinPermissionSummary = {};
  if (parsed.ref !== undefined) {
    const preview = projectWriteStdinInput(parsed.ref);
    summary.ref = { text: preview.text, truncated: preview.truncated };
  }
  if (parsed.actions !== undefined) {
    summary.input = projectTerminalInputActions(parsed.actions);
  } else if (parsed.input !== undefined) {
    summary.input = projectWriteStdinInput(parsed.input);
  }
  if (parsed.size !== undefined) summary.size = parsed.size;
  return summary;
}

export function formatWriteStdinPermissionInspection(args: unknown): string | undefined {
  const parsed = readWriteStdinArgs(args);
  if (!parsed) return undefined;
  const lines: string[] = [];
  if (parsed.ref !== undefined) {
    lines.push(`ref: ${escapeTerminalTextForInspection(parsed.ref)}`);
  }
  if (parsed.actions !== undefined) {
    lines.push(`actions: ${formatTerminalActionsForInspection(parsed.actions)}`);
  } else if (parsed.input !== undefined) {
    lines.push(`input: ${escapeTerminalTextForInspection(parsed.input)}`);
  }
  if (parsed.size !== undefined) {
    lines.push(`size: ${parsed.size.cols}x${parsed.size.rows}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

export function projectWriteStdinInput(input: string): WriteStdinInputPreview {
  const bytes = new TextEncoder().encode(input).byteLength;
  const exact = exactTerminalInputLabel(input);
  if (exact) return { text: exact, bytes, truncated: false };

  const safe = redactSecrets(input);
  const chars = Array.from(safe);
  let text = '';
  let length = 0;
  let consumed = 0;
  for (const char of chars) {
    const display = terminalInputCharDisplay(char);
    const displayLength = Array.from(display).length;
    if (length + displayLength > WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS) break;
    text += display;
    length += displayLength;
    consumed += 1;
  }
  return { text, bytes, truncated: consumed < chars.length };
}

function projectTerminalInputActions(
  actions: readonly TerminalInputAction[],
): WriteStdinInputPreview {
  const preview = projectWriteStdinInput(formatTerminalInputActions(actions));
  return { ...preview, bytes: encodedTerminalInputActionsByteLength(actions) };
}

export function readWriteStdinInputPreview(args: unknown): WriteStdinInputPreview | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>).inputPreview;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const preview = value as Record<string, unknown>;
  if (
    typeof preview.text !== 'string' ||
    !Number.isSafeInteger(preview.bytes) ||
    (preview.bytes as number) < 0 ||
    typeof preview.truncated !== 'boolean' ||
    !isSafeProjectedInputText(preview.text)
  ) {
    return undefined;
  }
  return {
    text: preview.text,
    bytes: preview.bytes as number,
    truncated: preview.truncated,
  };
}

function isSafeProjectedInputText(text: string): boolean {
  const chars = Array.from(text);
  return (
    chars.length <= WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS &&
    redactSecrets(text) === text &&
    chars.every((char) => terminalInputCharDisplay(char) === char)
  );
}

export function projectToolActivityArgs(toolName: string, args: unknown): unknown {
  if (toolName !== 'WriteStdin') return args;
  const parsed = readWriteStdinArgs(args);
  if (!parsed) return {};
  const input = args as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  if (parsed.ref !== undefined) summary.ref = boundedWriteStdinRef(parsed.ref);
  if (parsed.actions !== undefined) {
    summary.inputPreview = projectTerminalInputActions(parsed.actions);
  } else if (parsed.input !== undefined) {
    summary.inputPreview = projectWriteStdinInput(parsed.input);
  } else {
    const preview = readWriteStdinInputPreview(input);
    if (preview) summary.inputPreview = preview;
  }
  if (parsed.size !== undefined) summary.size = parsed.size;
  return summary;
}

function readWriteStdinArgs(args: unknown):
  | {
      ref?: string;
      input?: string;
      actions?: readonly TerminalInputAction[];
      size?: { cols: number; rows: number };
    }
  | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const value = args as Record<string, unknown>;
  const parsed: {
    ref?: string;
    input?: string;
    actions?: readonly TerminalInputAction[];
    size?: { cols: number; rows: number };
  } = {};
  if (typeof value.ref === 'string') parsed.ref = value.ref;
  if (typeof value.input === 'string') parsed.input = value.input;
  const actions = readTerminalInputActions(value.actions);
  if (actions) parsed.actions = actions;
  if (value.size && typeof value.size === 'object' && !Array.isArray(value.size)) {
    const size = value.size as Record<string, unknown>;
    if (Number.isSafeInteger(size.cols) && Number.isSafeInteger(size.rows)) {
      const cols = size.cols as number;
      const rows = size.rows as number;
      if (actions === undefined || cols !== 0 || rows !== 0) parsed.size = { cols, rows };
    }
  }
  return parsed;
}

function readTerminalInputActions(value: unknown): readonly TerminalInputAction[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const actions: TerminalInputAction[] = [];
  for (const item of value) {
    try {
      actions.push(parseTerminalInputAction(normalizeTerminalInputActionDefaults(item)));
    } catch {
      return undefined;
    }
  }
  return actions;
}

function formatTerminalActionsForInspection(actions: readonly TerminalInputAction[]): string {
  return actions
    .map((action) =>
      action.type === 'text'
        ? `{ text: ${escapeTerminalTextForInspection(action.text)} }`
        : action.type === 'key'
          ? `{ key: ${formatTerminalInputActions([action])} }`
          : `{ mouse: ${formatTerminalInputActions([action])} }`,
    )
    .join(' -> ');
}

function boundedWriteStdinRef(ref: string): string {
  const prefix: string[] = [];
  let length = 0;
  for (const char of ref) {
    length += 1;
    if (prefix.length < WRITE_STDIN_REF_PREVIEW_MAX_CHARS - 3) prefix.push(char);
    if (length > WRITE_STDIN_REF_PREVIEW_MAX_CHARS) return `${prefix.join('')}...`;
  }
  return ref;
}

function exactTerminalInputLabel(input: string): string | undefined {
  switch (input) {
    case '\r':
    case '\n':
    case '\r\n':
      return 'Enter';
    case '\u0003':
      return 'Ctrl-C';
    case '\u0004':
      return 'Ctrl-D';
    case '\u001b':
      return 'Esc';
    case '\b':
      return 'Backspace';
    case '\u007f':
      return 'Delete';
    default:
      return undefined;
  }
}

function terminalInputCharDisplay(char: string): string {
  switch (char) {
    case '\r':
      return '\\r';
    case '\n':
      return '\\n';
    case '\t':
      return '\\t';
    case '\b':
      return '<Backspace>';
    case '\u0003':
      return '<Ctrl-C>';
    case '\u0004':
      return '<Ctrl-D>';
    case '\u001b':
      return '<Esc>';
    case '\u007f':
      return '<Delete>';
    default: {
      const codePoint = char.codePointAt(0) ?? 0;
      if (codePoint < 0x20 || isInvisibleCodePoint(codePoint)) {
        return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`;
      }
      return char;
    }
  }
}

function isInvisibleCodePoint(codePoint: number): boolean {
  return /[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(
    String.fromCodePoint(codePoint),
  );
}
