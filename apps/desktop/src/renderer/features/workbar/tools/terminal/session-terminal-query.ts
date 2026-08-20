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

import type { IDisposable, IParser } from '@xterm/xterm';

export type TerminalParams = (number | number[])[];

interface TerminalQueryTarget {
  readonly parser: IParser;
  write(data: string): void;
}

interface ColorQueryAction {
  hasQuery: boolean;
  setters: string[];
}

const WINDOW_REPORT_OPERATIONS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);
const OSC_START = '\x1b]';
const STRING_TERMINATOR = '\x1b\\';

function firstParamIs(params: TerminalParams, expected: number): boolean {
  return params[0] === expected;
}

function getColorQueryAction(ident: number, data: string): ColorQueryAction {
  let hasQuery = false;
  const setters: string[] = [];

  if (ident === 4) {
    const parts = data.split(';');
    const setterParts: string[] = [];
    for (let offset = 0; offset + 1 < parts.length; offset += 2) {
      const indexText = parts[offset] ?? '';
      const value = parts[offset + 1] ?? '';
      const index = /^\d+$/.test(indexText) ? Number(indexText) : -1;
      if (index < 0 || index > 255) continue;
      if (value === '?') {
        hasQuery = true;
      } else {
        setterParts.push(indexText, value);
      }
    }
    if (setterParts.length > 0) {
      setters.push(`${OSC_START}4;${setterParts.join(';')}${STRING_TERMINATOR}`);
    }
    return { hasQuery, setters };
  }

  if (ident < 10 || ident > 12) return { hasQuery, setters };

  // OSC 10 can address foreground, background, and cursor colors by adding
  // values; OSC 11 can address the latter two, and OSC 12 only the cursor.
  // Replay non-query values separately because removing a query value would
  // otherwise shift every following value to the wrong color slot.
  const parts = data.split(';');
  for (let offset = 0; offset < parts.length && ident + offset <= 12; offset += 1) {
    const value = parts[offset] ?? '';
    if (value === '?') {
      hasQuery = true;
    } else {
      setters.push(`${OSC_START}${ident + offset};${value}${STRING_TERMINATOR}`);
    }
  }
  return { hasQuery, setters };
}

/** Returns true when an OSC color payload contains a reply-generating query. */
export function isColorQuery(ident: number, data: string): boolean {
  return getColorQueryAction(ident, data).hasQuery;
}

export function isDeviceAttributesQuery(params: TerminalParams): boolean {
  return firstParamIs(params, 0);
}

export function isXtVersionQuery(params: TerminalParams): boolean {
  return firstParamIs(params, 0);
}

export function isDeviceStatusQuery(params: TerminalParams): boolean {
  return firstParamIs(params, 5);
}

export function isWindowReportQuery(params: TerminalParams): boolean {
  const operation = params[0];
  if (typeof operation !== 'number' || !WINDOW_REPORT_OPERATIONS.has(operation)) {
    return false;
  }

  // CSI 14;2 t requests only the text-area size, which xterm does not report.
  return operation !== 14 || params[1] !== 2;
}

/**
 * Prevent xterm-generated capability replies from entering the durable Runtime
 * Resource input path. That path can deliver a reply after a short-lived probe
 * has restored canonical echo, making the reply visible at the next prompt.
 *
 * These handlers cover capability probes that xterm would otherwise answer into
 * onData: color reports, DA, XTVERSION, DSR status, mode/window reports, and DECRQSS.
 * Cursor-position reports (CSI 6 n / CSI ? 6 n) stay with xterm so full-screen
 * apps can still locate the cursor. Setters continue to xterm's handlers.
 * Mixed OSC color payloads are intercepted in full, then their setter-only
 * portions are written back so xterm applies them without emitting replies.
 */
export function suppressTerminalQueryReplies(terminal: TerminalQueryTarget): IDisposable {
  const { parser } = terminal;
  const handlers: IDisposable[] = [
    ...[4, 10, 11, 12].map((ident) =>
      parser.registerOscHandler(ident, (data) => {
        const action = getColorQueryAction(ident, data);
        if (!action.hasQuery) return false;
        for (const setter of action.setters) terminal.write(setter);
        return true;
      }),
    ),
    parser.registerCsiHandler({ final: 'c' }, isDeviceAttributesQuery),
    parser.registerCsiHandler({ prefix: '>', final: 'c' }, isDeviceAttributesQuery),
    parser.registerCsiHandler({ prefix: '>', final: 'q' }, isXtVersionQuery),
    parser.registerCsiHandler({ final: 'n' }, isDeviceStatusQuery),
    parser.registerCsiHandler({ intermediates: '$', final: 'p' }, () => true),
    parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => true),
    parser.registerCsiHandler({ final: 't' }, isWindowReportQuery),
    parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true),
  ];

  return {
    dispose() {
      for (const handler of handlers.reverse()) handler.dispose();
    },
  };
}
