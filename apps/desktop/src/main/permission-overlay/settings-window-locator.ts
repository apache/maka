/**
 * Where is the System Settings window?
 *
 * Thin wrapper over the bundled `settings-window-locator` binary (Swift,
 * `native/settings-window-locator/locator.swift`). Electron cannot answer
 * this — `screen.*` covers displays and the cursor, never a foreign
 * window — so this is the one native call the drag-to-grant card needs.
 *
 * Everything about this module is written to degrade rather than fail:
 * the binary may be absent (a build without the Xcode toolchain), the
 * user may have closed Settings, the process may hang. Each case resolves
 * to `null`, and the caller falls back to cursor anchoring — which is the
 * Stage 1 behaviour that shipped and works.
 *
 * The returned rect is in CoreGraphics space (top-left origin), which is
 * already what Electron's `setBounds` expects. See the Swift source for
 * why converting to AppKit coordinates is a bug and not a nicety.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface SettingsWindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LocatorFailure =
  | 'unsupported_platform'
  | 'binary_missing'
  | 'not_running'
  | 'no_settings_window'
  | 'window_list_failed'
  | 'spawn_failed'
  | 'timed_out'
  | 'bad_output';

export type LocatorResult =
  | { ok: true; frame: SettingsWindowFrame }
  | { ok: false; reason: LocatorFailure };

export interface LocateDeps {
  binaryPath: string;
  platform: NodeJS.Platform;
  timeoutMs: number;
  exists(path: string): boolean;
  runBinary(path: string, timeoutMs: number): Promise<{ stdout: string } | null>;
}

function parseFrame(stdout: string): LocatorResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, reason: 'bad_output' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'bad_output' };
  const value = parsed as Record<string, unknown>;

  if (value.ok !== true) {
    const reason = value.reason;
    // Only the reasons the binary actually emits are passed through; an
    // unknown string is treated as malformed rather than trusted.
    return {
      ok: false,
      reason:
        reason === 'not_running' || reason === 'no_settings_window' || reason === 'window_list_failed'
          ? reason
          : 'bad_output',
    };
  }

  const { x, y, width, height } = value;
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return { ok: false, reason: 'bad_output' };
  }
  // A zero-area window is not something to dock to.
  if ((width as number) <= 0 || (height as number) <= 0) {
    return { ok: false, reason: 'bad_output' };
  }
  return {
    ok: true,
    frame: { x: x as number, y: y as number, width: width as number, height: height as number },
  };
}

export async function locateSettingsWindow(deps: LocateDeps): Promise<LocatorResult> {
  if (deps.platform !== 'darwin') return { ok: false, reason: 'unsupported_platform' };
  if (!deps.exists(deps.binaryPath)) return { ok: false, reason: 'binary_missing' };

  const output = await deps.runBinary(deps.binaryPath, deps.timeoutMs);
  if (!output) return { ok: false, reason: 'spawn_failed' };
  return parseFrame(output.stdout);
}

/**
 * Default runner. `execFile` with a timeout, and a hard `killSignal` so a
 * wedged locator cannot hold the tracker's tick: the caller polls this on
 * an interval, and a hung child would otherwise pile up.
 */
export function defaultRunBinary(path: string, timeoutMs: number): Promise<{ stdout: string } | null> {
  return new Promise((resolve) => {
    execFile(
      path,
      [],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
      (error, stdout) => {
        // A timeout kill and a spawn failure both land here; the caller
        // cannot act differently on either, so both become null.
        if (error) resolve(null);
        else resolve({ stdout });
      },
    );
  });
}

export const defaultExists = existsSync;
