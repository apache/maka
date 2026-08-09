import { formatWithOptions } from 'node:util';
import type { DiagnosticLogBuffer } from './diagnostic-log.js';

const MAX_LOG_ENTRY_CODE_POINTS = 8 * 1024;

export function installConsoleDiagnosticLogCapture(buffer: DiagnosticLogBuffer): void {
  for (const level of ['debug', 'info', 'log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        buffer.append(
          level,
          formatWithOptions(
            {
              breakLength: 160,
              colors: false,
              compact: 3,
              depth: 4,
              maxArrayLength: 50,
              maxStringLength: MAX_LOG_ENTRY_CODE_POINTS,
            },
            ...args,
          ),
        );
      } catch {
        // Diagnostic capture must not change console behavior.
      }
      original(...args);
    };
  }
}
