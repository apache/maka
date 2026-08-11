import { DiagnosticLogBuffer } from '@maka/core/diagnostic-log';
import { installConsoleDiagnosticLogCapture } from '@maka/core/node-diagnostic-log';
import {
  HOST_DIAGNOSTIC_LOG_MAX_ENTRIES,
  HOST_DIAGNOSTIC_LOG_MAX_ENTRY_BYTES,
} from './protocol/host-status.js';

export const runtimeHostLogBuffer = new DiagnosticLogBuffer({
  maxBytes: 48 * 1024,
  maxEntries: HOST_DIAGNOSTIC_LOG_MAX_ENTRIES,
  maxEntryUtf8Bytes: HOST_DIAGNOSTIC_LOG_MAX_ENTRY_BYTES,
});

let logCaptureInstalled = false;

export function installRuntimeHostLogCapture(buffer = runtimeHostLogBuffer): void {
  if (logCaptureInstalled) return;
  logCaptureInstalled = true;
  installConsoleDiagnosticLogCapture(buffer);
}
