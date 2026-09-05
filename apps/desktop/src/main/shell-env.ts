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

// apps/desktop/src/main/shell-env.ts
//
// Resolve the user's login-shell PATH at Electron startup.
//
// On macOS (and Linux), apps launched from Finder / Dock / Spotlight inherit
// a minimal environment — PATH is typically just /usr/bin:/bin:/usr/sbin:/sbin.
// User-installed tools (homebrew, ~/.local/bin, nvm, pyenv, etc.) are absent
// because the GUI process never sources ~/.zshrc / ~/.bash_profile.
//
// This module spawns the user's login shell, captures its PATH with UUID
// markers, and applies that one value to process.env. Application-control
// variables remain owned by the process that launched Maka.
//
// Call `resolveShellEnv()` once, early in main.ts, before any stores, tools,
// or child processes are created.

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { basename } from 'node:path';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const ELECTRON_PROBE_ENV = {
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_NO_ATTACH_CONSOLE: '1',
} as const;

/**
 * Resolve the user's login-shell PATH and apply it to `process.env`.
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
export async function resolveShellEnv(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  if (process.platform === 'win32') return;
  if (process.env.MAKA_SKIP_SHELL_ENV === '1') return;
  if (process.env.TERM || process.env.COLORTERM) return;

  try {
    process.env.PATH = await captureLoginShellPath(timeoutMs);
    const pathEntries = process.env.PATH.split(':').length;
    console.log(`[shell-env] resolved login-shell PATH (${pathEntries} entries)`);
  } catch (err) {
    console.warn(
      `[shell-env] failed to resolve login-shell PATH: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Build the shell command + argv that capture the login shell's PATH as a
 * marker-wrapped JSON blob. Exported so the per-shell
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
  // The binary prints only PATH. Importing the entire login environment would
  // let shell startup files inject Maka's test, debug, and renderer controls
  // into the already-running application.
  const payload = 'JSON.stringify({ PATH: process.env.PATH })';

  if (/^(?:pwsh|powershell)(?:-preview)?$/.test(shellName)) {
    // PowerShell single-quoted strings escape an embedded apostrophe by
    // doubling it (`''`).
    const escapedExec = `'${execPath.replace(/'/g, "''")}'`;
    return {
      command: `& ${escapedExec} -p '''${mark}'' + ${payload} + ''${mark}'''`,
      shellArgs: ['-Login', '-Command'],
    };
  }

  if (shellName === 'nu') {
    // nu raw strings (`^'...'`) cannot escape an embedded quote, so execPath
    // is left as-is — a known edge case (reviewer-accepted).
    return {
      command: `^'${execPath}' -p '"${mark}" + ${payload} + "${mark}"'`,
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
    command: `${escapedExec} -p '"${mark}" + ${payload} + "${mark}"'`,
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
 * Prefer the inherited shell, then the OS account shell. GUI launches often
 * omit SHELL, so a platform default is only the last resort.
 */
export function selectLoginShell(
  inheritedShell: string | undefined,
  accountShell: string | null | undefined,
  platform: NodeJS.Platform,
): string {
  return (
    inheritedShell?.trim() ||
    accountShell?.trim() ||
    (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  );
}

/**
 * Kill the detached shell process group so startup-file descendants do not
 * survive the dedicated capture, regardless of how it settles.
 */
function terminateProbe(child: ReturnType<typeof spawn>): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall through if the process group has already exited.
    }
  }
  child.kill('SIGKILL');
}

/**
 * Spawn the user's login shell and capture only its PATH.
 */
async function captureLoginShellPath(timeoutMs: number): Promise<string> {
  let accountShell: string | null | undefined;
  try {
    accountShell = userInfo().shell;
  } catch {
    // Account lookup can fail in constrained runtimes; use the platform fallback.
  }
  const shell = selectLoginShell(process.env.SHELL, accountShell, process.platform);
  const shellName = basename(shell);

  // Build a command that prints the shell's environment as JSON, wrapped in
  // unique markers so we can extract it from potentially noisy shell output
  // (motd, conda banners, etc.).
  const mark = randomUUID().replace(/-/g, '').slice(0, 12);
  const markerRegex = buildMarkerRegex(mark);
  const { command, shellArgs } = buildCaptureCommand(shellName, process.execPath, mark);

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...ELECTRON_PROBE_ENV,
  };

  return new Promise<string>((resolve, reject) => {
    const child = spawn(shell, [...shellArgs, command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const stdoutChunks: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      terminateProbe(child);
      cleanup();
      reject(error);
    };

    const succeed = (path: string) => {
      if (settled) return;
      settled = true;
      terminateProbe(child);
      cleanup();
      resolve(path);
    };

    const capture = (chunk: Buffer, keep: boolean) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        fail(new Error(`shell output exceeded ${MAX_CAPTURE_BYTES} bytes`));
        return;
      }
      if (keep) stdoutChunks.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => capture(chunk, true));
    // Count stderr toward the bound but never retain or log shell-controlled
    // bytes: startup files may print secrets.
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, false));

    child.on('error', (err) => {
      fail(new Error(`failed to spawn ${shell}: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0 && code !== null) {
        fail(new Error(`${shell} exited with code ${code}${signal ? ` (signal ${signal})` : ''}`));
        return;
      }

      const raw = Buffer.concat(stdoutChunks).toString('utf8');
      const match = markerRegex.exec(raw);
      if (!match) {
        fail(new Error(`could not find PATH markers in ${shell} output`));
        return;
      }

      try {
        const parsed = JSON.parse(match[1]) as Record<string, string>;
        if (typeof parsed.PATH !== 'string' || parsed.PATH.length === 0) {
          throw new Error('captured login shell did not provide PATH');
        }
        succeed(parsed.PATH);
      } catch {
        fail(new Error('failed to parse PATH JSON'));
      }
    });

    timer = setTimeout(() => {
      fail(new Error(`timed out after ${timeoutMs}ms spawning ${shell}`));
    }, timeoutMs);
  });
}
