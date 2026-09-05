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

import type {
  TerminalInputModifier,
  TerminalInputState,
  TerminalMouseButton,
  TerminalMouseEvent,
  TerminalMouseInputAction,
  TerminalMouseTrackingMode,
} from './terminal-input.js';

export class TerminalMouseInputRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalMouseInputRejectedError';
  }
}

export function encodeTerminalMouseInputAction(
  action: TerminalMouseInputAction,
  state: TerminalInputState,
): string {
  if (action.x >= state.cols || action.y >= state.rows) {
    throw new TerminalMouseInputRejectedError(
      `Terminal mouse coordinates (${action.x}, ${action.y}) are outside ${state.cols}x${state.rows}`,
    );
  }
  if (state.mouseEncoding !== 'sgr') {
    throw new TerminalMouseInputRejectedError(
      'The PTY has not enabled SGR cell mouse reporting; use keyboard input',
    );
  }
  assertMouseEventSupported(action, state.mouseTrackingMode);
  return encodeSgrTerminalMouseInputAction(action);
}

export function encodeSgrTerminalMouseInputAction(action: TerminalMouseInputAction): string {
  switch (action.event) {
    case 'click':
      return `${encodeSgrMouseEvent(action, 'press')}${encodeSgrMouseEvent(action, 'release')}`;
    case 'scroll':
    case 'press':
    case 'release':
    case 'move':
      return encodeSgrMouseEvent(action, action.event);
  }
}

export function formatTerminalMouseInputAction(action: TerminalMouseInputAction): string {
  const modifiers = action.modifiers?.map(formatModifier).join('-');
  const subject =
    action.event === 'scroll'
      ? `Scroll${action.direction === 'down' ? 'Down' : 'Up'}`
      : `${formatMouseEvent(action.event)}${action.button ? ` ${formatMouseButton(action.button)}` : ''}`;
  return `${modifiers ? `${modifiers}-` : ''}${subject} @ (${action.x}, ${action.y})`;
}

function assertMouseEventSupported(
  action: TerminalMouseInputAction,
  mode: TerminalMouseTrackingMode,
): void {
  if (mode === 'none') {
    throw new TerminalMouseInputRejectedError(
      'The PTY has not enabled mouse tracking; use keyboard input',
    );
  }
  if (mode === 'x10') {
    if (action.event !== 'press') {
      throw new TerminalMouseInputRejectedError('The PTY mouse mode only accepts button presses');
    }
    if ((action.modifiers?.length ?? 0) > 0) {
      throw new TerminalMouseInputRejectedError('The PTY mouse mode does not accept modifiers');
    }
  }
  if (action.event === 'move') {
    if (mode === 'x10' || mode === 'vt200') {
      throw new TerminalMouseInputRejectedError(
        'The PTY mouse mode does not accept pointer movement',
      );
    }
    if (mode === 'drag' && !action.button) {
      throw new TerminalMouseInputRejectedError(
        'The PTY mouse mode only accepts movement with a pressed button',
      );
    }
  }
}

function encodeSgrMouseEvent(
  action: TerminalMouseInputAction,
  event: Exclude<TerminalMouseEvent, 'click'>,
): string {
  const modifiers = new Set(action.modifiers ?? []);
  let code =
    (modifiers.has('shift') ? 4 : 0) +
    (modifiers.has('alt') ? 8 : 0) +
    (modifiers.has('ctrl') ? 16 : 0);
  if (event === 'scroll') {
    code += action.direction === 'down' ? 65 : 64;
  } else {
    code += mouseButtonCode(action.button);
    if (event === 'move') code += 32;
  }
  const final = event === 'release' ? 'm' : 'M';
  return `\u001b[<${code};${action.x + 1};${action.y + 1}${final}`;
}

function mouseButtonCode(button: TerminalMouseButton | undefined): number {
  switch (button) {
    case 'left':
      return 0;
    case 'middle':
      return 1;
    case 'right':
      return 2;
    case undefined:
      return 3;
  }
}

function formatMouseEvent(event: Exclude<TerminalMouseEvent, 'scroll'>): string {
  return `${event[0]?.toUpperCase()}${event.slice(1)}`;
}

function formatMouseButton(button: TerminalMouseButton): string {
  return `${button[0]?.toUpperCase()}${button.slice(1)}`;
}

function formatModifier(modifier: TerminalInputModifier): string {
  switch (modifier) {
    case 'ctrl':
      return 'Ctrl';
    case 'alt':
      return 'Alt';
    case 'shift':
      return 'Shift';
  }
}
