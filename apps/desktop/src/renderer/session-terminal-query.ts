import type { IDisposable, IParser } from '@xterm/xterm';

export type TerminalParams = (number | number[])[];

const WINDOW_REPORT_OPERATIONS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);

function isSingleParam(params: TerminalParams, expected: number): boolean {
  return params.length === 1 && params[0] === expected;
}

/** Returns true only for pure OSC color queries, never for color setters. */
export function isColorQuery(ident: number, data: string): boolean {
  if (ident === 4) {
    const parts = data.split(';');
    if (parts.length === 0 || parts.length % 2 !== 0) return false;
    for (let index = 0; index < parts.length; index += 2) {
      if (!/^\d+$/.test(parts[index] ?? '') || parts[index + 1] !== '?') {
        return false;
      }
    }
    return true;
  }

  // OSC 10 may query foreground, background, and cursor colors together by
  // supplying additional semicolon-separated question marks. OSC 11 and 12
  // use the same payload grammar for their respective color.
  return (
    (ident === 10 || ident === 11 || ident === 12) &&
    data.length > 0 &&
    data.split(';').every((part) => part === '?')
  );
}

export function isDeviceAttributesQuery(params: TerminalParams): boolean {
  return isSingleParam(params, 0);
}

export function isDeviceStatusQuery(params: TerminalParams): boolean {
  return isSingleParam(params, 5) || isSingleParam(params, 6);
}

export function isPrivateDeviceStatusQuery(params: TerminalParams): boolean {
  return isSingleParam(params, 6);
}

export function isWindowReportQuery(params: TerminalParams): boolean {
  return (
    params.length === 1 &&
    typeof params[0] === 'number' &&
    WINDOW_REPORT_OPERATIONS.has(params[0])
  );
}

/**
 * Prevent xterm-generated capability replies from entering the durable Runtime
 * Resource input path. That path can deliver a reply after a short-lived probe
 * has restored canonical echo, making the reply visible at the next prompt.
 *
 * These handlers cover every response-generating query implemented by xterm:
 * color reports, device attributes/status, mode/window reports, and DECRQSS.
 * Setters and other terminal control sequences continue to xterm's handlers.
 */
export function suppressTerminalQueryReplies(parser: IParser): IDisposable {
  const handlers: IDisposable[] = [
    ...[4, 10, 11, 12].map((ident) =>
      parser.registerOscHandler(ident, (data) => isColorQuery(ident, data)),
    ),
    parser.registerCsiHandler({ final: 'c' }, isDeviceAttributesQuery),
    parser.registerCsiHandler(
      { prefix: '>', final: 'c' },
      isDeviceAttributesQuery,
    ),
    parser.registerCsiHandler({ final: 'n' }, isDeviceStatusQuery),
    parser.registerCsiHandler(
      { prefix: '?', final: 'n' },
      isPrivateDeviceStatusQuery,
    ),
    parser.registerCsiHandler({ intermediates: '$', final: 'p' }, () => true),
    parser.registerCsiHandler(
      { prefix: '?', intermediates: '$', final: 'p' },
      () => true,
    ),
    parser.registerCsiHandler({ final: 't' }, isWindowReportQuery),
    parser.registerDcsHandler(
      { intermediates: '$', final: 'q' },
      () => true,
    ),
  ];

  return {
    dispose() {
      for (const handler of handlers.reverse()) handler.dispose();
    },
  };
}
