// apps/desktop/src/main/shell-env.ts
//
// Resolve the user's login-shell environment at Electron startup.
//
// On macOS (and Linux), apps launched from Finder / Dock / Spotlight inherit
// a minimal environment — PATH is typically just /usr/bin:/bin:/usr/sbin:/sbin.
// User-installed tools (homebrew, ~/.local/bin, nvm, pyenv, etc.) are absent
// because the GUI process never sources ~/.zshrc / ~/.bash_profile.
//
// This module spawns the user's login shell, captures its full environment via
// JSON.stringify(process.env) with UUID markers, and merges the result into
// process.env. This is the same battle-tested approach VS Code uses
// (src/vs/platform/shell/node/shellEnv.ts).
//
// Call `resolveShellEnv()` once, early in main.ts, before any stores, tools,
// or child processes are created.

import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Resolve the user's login-shell environment and merge it into `process.env`.
 *
 * Skips resolution when:
 * - Running on Windows (shell env works differently)
 * - `MAKA_SKIP_SHELL_ENV=1` is set (escape hatch for CI / debugging)
 * - Launched from a terminal / dev shell (`TERM` or `COLORTERM` is set).
 *   LaunchServices (Finder / Dock / Spotlight) never sets either, while every
 *   terminal and CLI launch always does — so their presence means the session
 *   already inherited a complete environment and resolution is wasted work.
 *
 * On failure the function logs a warning and returns silently — the app
 * continues with whatever environment Electron was given.
 */
export async function resolveShellEnv(): Promise<void> {
  if (process.platform === 'win32') return;
  if (process.env.MAKA_SKIP_SHELL_ENV === '1') return;
  if (process.env.TERM || process.env.COLORTERM) return;

  try {
    const env = await captureLoginShellEnv(DEFAULT_TIMEOUT_MS);
    mergeEnv(env);
  } catch (err) {
    console.warn(
      `[shell-env] failed to resolve login-shell environment: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Build the shell command + argv that capture the login shell's full
 * environment as a marker-wrapped JSON blob. Exported so the per-shell
 * quoting rules and marker layout can be unit-tested in isolation (matching
 * the sibling-module pattern: `resolveBuildInfo`, `buildStdioEnvironment`).
 *
 * `execPath` is the Node/Electron binary that prints the env; it is
 * shell-escaped per the target shell's single-quoting rules so a path
 * containing an apostrophe (e.g. `/Users/Bob's/bin`) round-trips safely.
 */
export function buildCaptureCommand(
  shellName: string,
  execPath: string,
  mark: string,
): { command: string; shellArgs: string[] } {
  // The inner payload is identical to VS Code's: the binary runs Node and
  // prints `mark + JSON.stringify(process.env) + mark` with no padding, so
  // the markers sit flush against the `{` / `}` the capture regex anchors on.

  if (/^(?:pwsh|powershell)(?:-preview)?$/.test(shellName)) {
    // PowerShell single-quoted strings escape an embedded apostrophe by
    // doubling it (`''`).
    const escapedExec = `'${execPath.replace(/'/g, "''")}'`;
    return {
      command: `& ${escapedExec} -p '''${mark}'' + JSON.stringify(process.env) + ''${mark}'''`,
      shellArgs: ['-Login', '-Command'],
    };
  }

  if (shellName === 'nu') {
    // nu raw strings (`^'...'`) cannot escape an embedded quote, so execPath
    // is left as-is — a known edge case (reviewer-accepted).
    return {
      command: `^'${execPath}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`,
      shellArgs: ['-i', '-l', '-c'],
    };
  }

  // POSIX family: bash, zsh, fish, sh, tcsh, csh. xonsh is intentionally
  // unsupported (not a Maka audience) and falls through here — the previous
  // dedicated branch never matched the capture regex anyway. A real xonsh
  // shell fails to capture gracefully and the app continues with the
  // original env. POSIX single-quoting escapes an embedded apostrophe as
  // the close-quote / literal-quote / reopen-quote sequence `'\''`.
  const escapedExec = `'${execPath.replace(/'/g, "'\\''")}'`;
  return {
    command: `${escapedExec} -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`,
    shellArgs: shellName === 'tcsh' || shellName === 'csh' ? ['-ic'] : ['-i', '-l', '-c'],
  };
}

/**
 * Build the regex that extracts the marker-wrapped JSON body from captured
 * shell output. Exported so the adjacency contract (marker flush against
 * the object braces) can be unit-tested.
 */
export function buildMarkerRegex(mark: string): RegExp {
  return new RegExp(`${mark}(\\{[\\s\\S]*\\})${mark}`);
}

/**
 * Spawn the user's login shell and capture its full environment.
 */
async function captureLoginShellEnv(timeoutMs: number): Promise<Record<string, string>> {
  const shell = process.env.SHELL ?? '/bin/zsh';
  const shellName = basename(shell);

  // Build a command that prints the shell's environment as JSON, wrapped in
  // unique markers so we can extract it from potentially noisy shell output
  // (motd, conda banners, etc.).
  const mark = randomUUID().replace(/-/g, '').slice(0, 12);
  const markerRegex = buildMarkerRegex(mark);
  const { command, shellArgs } = buildCaptureCommand(shellName, process.execPath, mark);

  const env: Record<string, string | undefined> = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
  };

  return new Promise<Record<string, string>>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after ${timeoutMs}ms spawning ${shell}`));
    }, timeoutMs);

    const child = spawn(shell, [...shellArgs, command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on('data', (b: Buffer) => stderrChunks.push(b));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn ${shell}: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      const raw = Buffer.concat(stdoutChunks).toString('utf8');
      const stderrStr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (stderrStr) {
        // Shell init noise is expected; only log at debug level.
        console.debug(`[shell-env] stderr from ${shell}: ${stderrStr.slice(0, 500)}`);
      }

      if (code !== 0 && code !== null) {
        reject(new Error(`${shell} exited with code ${code}${signal ? ` (signal ${signal})` : ''}`));
        return;
      }

      const match = markerRegex.exec(raw);
      if (!match) {
        reject(new Error(`could not find environment markers in ${shell} output`));
        return;
      }

      try {
        const parsed = JSON.parse(match[1]) as Record<string, string>;
        resolve(parsed);
      } catch (err) {
        reject(new Error(`failed to parse environment JSON: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}

/**
 * Merge resolved shell environment into `process.env`. Exported so the
 * preservation / stripping rules can be unit-tested.
 *
 * The resolved env takes precedence for PATH and other user-configured
 * variables, but we preserve certain Electron-specific variables that the
 * resolved shell env would not have. Preservation uses a prefix rule over
 * the `MAKA_*` namespace (plus the Electron trio) so it survives future
 * `MAKA_*` renames without a hand-maintained allowlist.
 */
export function mergeEnv(resolved: Record<string, string>): void {
  // Snapshot the Electron-specific + MAKA_* keys before the resolved env
  // overwrites them. Scanning `process.env` (not a fixed list) means every
  // currently-set MAKA_* value is restored verbatim.
  const preservedKeys = Object.keys(process.env).filter(
    (key) =>
      key === 'ELECTRON_RUN_AS_NODE' ||
      key === 'ELECTRON_NO_ATTACH_CONSOLE' ||
      key === 'ORIGINAL_XDG_CURRENT_DESKTOP' ||
      key.startsWith('MAKA_'),
  );
  const preserved: Record<string, string | undefined> = {};
  for (const key of preservedKeys) {
    preserved[key] = process.env[key];
  }

  // The login shell's runtime dir must not persist into GUI-process children
  // (microsoft/vscode#22593). macOS is unaffected, but strip unconditionally
  // so the resolved value never overwrites whatever the GUI process had.
  delete resolved.XDG_RUNTIME_DIR;

  // Apply the resolved environment.
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }

  // Restore preserved keys (delete any that were absent originally).
  for (const [key, value] of Object.entries(preserved)) {
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }

  const pathEntries = (process.env.PATH ?? '').split(':').length;
  console.log(`[shell-env] resolved login-shell environment (${pathEntries} PATH entries)`);
}
