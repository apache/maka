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

// packages/runtime/src/shell-detect.ts
//
// Which shell runs Bash tool commands, and how to tell the model about it.
//
// Node's `spawn(cmd, { shell: true })` silently picks the platform default:
// /bin/sh on POSIX, cmd.exe on Windows. cmd.exe is the weakest shell on any
// modern Windows box (no pipelines over objects, no regex, ancient syntax), so
// the model is trapped writing `dir /s /b` style commands. This module detects
// a better shell (pwsh > powershell > cmd) and carries the result to the two
// places that need it: the spawn call (shell-exec / shell-run-manager) and the
// prompt surfaces that must DECLARE the dialect to the model (tool description,
// session environment fragment). Selection without declaration — or the other
// way round — makes the model guess the dialect, which is the original bug.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import type { ShellSettings } from '@maka/core/settings';

export type ShellKind = 'posix' | 'git-bash' | 'legacy-wsl-bash' | 'pwsh' | 'powershell' | 'cmd';

export interface ShellPlan {
  kind: ShellKind;
  /** Human-readable name for prompt surfaces, e.g. "PowerShell 7 (pwsh)". */
  displayName: string;
  /** Executable to spawn explicitly for non-default shell plans. */
  exe?: string;
}

export interface DetectShellInput {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

export type ShellPreferenceErrorCode =
  | 'unsupported_platform'
  | 'invalid_executable'
  | 'executable_missing'
  | 'not_bash';

export class ShellPreferenceError extends Error {
  constructor(
    readonly code: ShellPreferenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShellPreferenceError';
  }
}

export interface ResolveShellPlanInput extends DetectShellInput {}

/**
 * The one Host-owned shell resolution captured at turn admission. `plan`
 * drives model guidance and Bash execution for the whole turn so a mid-turn
 * settings change cannot split guidance from execution; a broken saved
 * preference rides along as `setupError` instead of throwing at composition
 * time, so text-only turns keep working while the Bash/PTY boundary stays
 * fail-closed (and never falls back to another shell).
 */
export interface TurnShellPlan {
  readonly plan: ShellPlan;
  readonly setupError?: ShellPreferenceError;
}

/** Resolves the Host-owned user preference into the one plan every shell surface consumes. */
export function resolveShellPlan(
  settings: ShellSettings,
  input: ResolveShellPlanInput = {},
): ShellPlan {
  if (settings.preference === 'auto') {
    return input.platform !== undefined || input.env !== undefined || input.fileExists !== undefined
      ? detectShell(input)
      : defaultShellPlan();
  }
  const platform = input.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new ShellPreferenceError(
      'unsupported_platform',
      'Git Bash can only be selected on a Windows Runtime Host',
    );
  }
  const executable = settings.executable.trim();
  if (!win32.isAbsolute(executable) || win32.basename(executable).toLowerCase() !== 'bash.exe') {
    throw new ShellPreferenceError(
      'invalid_executable',
      'Git Bash must use an absolute path to bash.exe',
    );
  }
  const fileExists = input.fileExists ?? defaultFileExists;
  if (!fileExists(executable)) {
    throw new ShellPreferenceError('executable_missing', 'The configured Git Bash was not found');
  }
  if (isLegacyWslShim(executable, input.env ?? process.env)) {
    return { kind: 'legacy-wsl-bash', displayName: 'Legacy WSL Bash', exe: executable };
  }
  return { kind: 'git-bash', displayName: 'Git Bash', exe: executable };
}

/**
 * Resolves the turn-scoped shell plan without throwing. A saved preference
 * whose executable moved or was uninstalled is a repairable optional-tool
 * configuration error: composition must not widen it into whole-turn
 * unavailability, so the failure is captured in `setupError` and the Bash/PTY
 * boundary re-throws it when a command actually runs.
 */
export function resolveTurnShellPlan(
  settings: ShellSettings,
  input: ResolveShellPlanInput = {},
): TurnShellPlan {
  try {
    return { plan: resolveShellPlan(settings, input) };
  } catch (error) {
    if (error instanceof ShellPreferenceError) {
      return { plan: defaultShellPlan(), setupError: error };
    }
    throw error;
  }
}

/** Fail-closed gate for the Bash/PTY boundary: never execute through a broken preference. */
export function throwIfShellSetupFailed(shell: TurnShellPlan): void {
  if (shell.setupError) throw shell.setupError;
}

/** Model-facing shell name; a broken preference is declared, not silently hidden. */
export function turnShellDisplayName(shell: TurnShellPlan): string {
  return shell.setupError ? `Unavailable (${shell.setupError.message})` : shell.plan.displayName;
}

export interface ValidateShellPreferenceInput extends ResolveShellPlanInput {
  probeVersion?: (executable: string) => Promise<string>;
}

/** Rejects a persisted override unless the Host can execute it as GNU Bash. */
export async function validateShellPreference(
  settings: ShellSettings,
  input: ValidateShellPreferenceInput = {},
): Promise<ShellPlan> {
  const plan = resolveShellPlan(settings, input);
  if ((plan.kind !== 'git-bash' && plan.kind !== 'legacy-wsl-bash') || !plan.exe) return plan;
  let version: string;
  try {
    version = await (input.probeVersion ?? probeBashVersion)(plan.exe);
  } catch {
    throw new ShellPreferenceError('not_bash', 'The configured executable could not run Bash');
  }
  if (!/\bGNU bash, version\b/i.test(version)) {
    throw new ShellPreferenceError('not_bash', 'The configured executable is not GNU Bash');
  }
  return plan;
}

export function detectShell(input: DetectShellInput = {}): ShellPlan {
  const platform = input.platform ?? process.platform;
  if (platform !== 'win32') return { kind: 'posix', displayName: '/bin/sh' };
  const env = input.env ?? process.env;
  const fileExists = input.fileExists ?? defaultFileExists;
  const pwsh =
    findOnWindowsPath('pwsh.exe', env, fileExists) ??
    findAt(env.ProgramFiles, 'PowerShell\\7\\pwsh.exe', fileExists);
  if (pwsh) return { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: pwsh };
  const powershell =
    findOnWindowsPath('powershell.exe', env, fileExists) ??
    findAt(env.SystemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe', fileExists);
  if (powershell)
    return { kind: 'powershell', displayName: 'Windows PowerShell 5.1', exe: powershell };
  return { kind: 'cmd', displayName: 'cmd.exe' };
}

/**
 * The shell for this process's real platform/env, detected once and cached:
 * detection touches the filesystem, and every Bash tool call would otherwise
 * repeat it. The environment a desktop app runs in does not change under it.
 */
export function defaultShellPlan(): ShellPlan {
  cachedDefault ??= detectShell();
  return cachedDefault;
}

let cachedDefault: ShellPlan | undefined;

/**
 * How to hand `command` to spawn() for the given shell. PowerShell is spawned
 * explicitly (never via `shell: true`): Node's shell option only knows cmd.exe
 * quoting on Windows, and PowerShell needs its non-interactive flags anyway.
 */
export interface ShellSpawnPlan {
  file: string;
  args: string[];
  useShellOption: boolean;
  /** Required environment snapshot; callers must pass it to spawn when present. */
  env?: NodeJS.ProcessEnv;
  /** Script body for shells whose executable consumes commands from stdin. */
  stdin?: string;
}

export interface PtyShellSpawnPlan {
  file: string;
  args: string[];
  /** Required environment snapshot; callers must pass it to the PTY when present. */
  env?: NodeJS.ProcessEnv;
}

// PowerShell's -Command maps the process exit code to 0/1 from $? — a native
// command exiting 42 comes back as 1 (about_Pwsh: "that exit code is converted
// to 1"). Appended after the user command, this re-raises $LASTEXITCODE, but
// only when the FINAL statement failed: a recovered failure (native exit 3,
// then a succeeding cmdlet) still exits 0, matching sh -c semantics, and a
// failing cmdlet with no native exit code still maps to 1. $? must be captured
// before the if-statement evaluates (which would reset it). Verified against
// real pwsh; works on Windows PowerShell 5.1 syntax too.
//
// Deliberate boundary: when the final statement failed, an earlier native exit
// code wins over a final cmdlet failure (exit 42 where plain pwsh would say 1).
// The tail cannot tell which statement tripped $?, and the only observable
// ($Error growth) would misreport the common "cmdlet noise, then native
// command fails last" shape back to 1. Both outcomes are non-zero either way;
// stderr still carries the cmdlet error. Pinned in shell-exec.test.ts.
const POWERSHELL_EXIT_CODE_TAIL =
  '$__makaOk = $?\n' +
  'if (-not $__makaOk) { if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 } }';

// Node decodes both pipe and PTY output as UTF-8. PowerShell 7 already defaults
// to UTF-8, but Windows PowerShell 5.1 can inherit a legacy console code page
// and corrupt non-ASCII output before Node sees it. Set both sides of the
// PowerShell/native-program boundary: Console.OutputEncoding controls bytes
// written by PowerShell, while $OutputEncoding controls text piped to native
// commands. UTF8Encoding(false) avoids a BOM at the start of every shell run.
const POWERSHELL_UTF8_BOOTSTRAP =
  '$__makaUtf8 = [System.Text.UTF8Encoding]::new($false)\n' +
  '[Console]::OutputEncoding = $__makaUtf8\n' +
  '$OutputEncoding = $__makaUtf8';

const POWERSHELL_COMMAND_ENV = '__MAKA_RUNTIME_POWERSHELL_COMMAND';

function buildPowerShellCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): { script: string; env: NodeJS.ProcessEnv } {
  // Keep the user command as its own parsed script. Prefixing statements
  // directly would invalidate command text that begins with script-level
  // syntax such as `using namespace`. Carry it outside argv so wrapping does
  // not shrink Windows' command-line budget, then remove the private slot
  // before user code or any descendant process can inspect the environment.
  const invokeCommand =
    `$__makaCommandText = [Environment]::GetEnvironmentVariable('${POWERSHELL_COMMAND_ENV}')\n` +
    `[Environment]::SetEnvironmentVariable('${POWERSHELL_COMMAND_ENV}', $null)\n` +
    '$__makaCommand = [ScriptBlock]::Create($__makaCommandText)\n' +
    '. $__makaCommand';
  const inheritedEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== POWERSHELL_COMMAND_ENV),
  );
  return {
    script: `${POWERSHELL_UTF8_BOOTSTRAP}\n${invokeCommand}`,
    env: {
      ...inheritedEnv,
      [POWERSHELL_COMMAND_ENV]: `${command}\n${POWERSHELL_EXIT_CODE_TAIL}`,
    },
  };
}

export function buildShellSpawnPlan(
  shell: ShellPlan,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): ShellSpawnPlan {
  if (shell.kind === 'legacy-wsl-bash') {
    return {
      file: requireExplicitShellExecutable(shell),
      args: ['-s'],
      useShellOption: false,
      stdin: `${command}\n`,
    };
  }
  if (shell.kind === 'git-bash') {
    return {
      file: requireExplicitShellExecutable(shell),
      args: ['-c', command],
      useShellOption: false,
    };
  }
  if ((shell.kind === 'pwsh' || shell.kind === 'powershell') && shell.exe) {
    const wrapped = buildPowerShellCommand(command, env);
    return {
      file: shell.exe,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapped.script],
      useShellOption: false,
      env: wrapped.env,
    };
  }
  return { file: command, args: [], useShellOption: true };
}

export function buildPtyShellSpawnPlan(
  shell: ShellPlan,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): PtyShellSpawnPlan {
  if (shell.kind === 'legacy-wsl-bash') {
    return { file: requireExplicitShellExecutable(shell), args: ['-c', command] };
  }
  if (shell.kind === 'git-bash') {
    return { file: requireExplicitShellExecutable(shell), args: ['-c', command] };
  }
  if ((shell.kind === 'pwsh' || shell.kind === 'powershell') && shell.exe) {
    const wrapped = buildPowerShellCommand(command, env);
    return {
      file: shell.exe,
      args: ['-NoLogo', '-NoProfile', '-Command', wrapped.script],
      env: wrapped.env,
    };
  }
  if (shell.kind === 'cmd') {
    return {
      file: env.ComSpec || env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

/**
 * Shell-dialect sentence for Bash tool descriptions. Empty on POSIX (the
 * historical description is the contract there). On Windows this is the other
 * half of shell selection: without it the model guesses the dialect — the
 * original `dir /s /b` bug.
 */
export function bashToolShellGuidance(shell: ShellPlan): string {
  if (shell.kind === 'posix') return '';
  const dialect =
    shell.kind === 'git-bash' || shell.kind === 'legacy-wsl-bash'
      ? `Commands are executed by ${shell.displayName}; write POSIX shell syntax, not PowerShell or cmd syntax.`
      : shell.kind === 'pwsh'
        ? 'Commands are executed by PowerShell 7 (pwsh); write PowerShell syntax, not cmd or bash syntax.'
        : shell.kind === 'powershell'
          ? 'Commands are executed by Windows PowerShell 5.1; write PowerShell 5.1-compatible syntax, not cmd or bash syntax.'
          : 'Commands are executed by cmd.exe; write cmd syntax, not bash syntax.';
  return `${dialect} Prefer \`git ls-files\` or the Grep/Glob tools over recursive directory listings, and always exclude node_modules and build output when enumerating files.`;
}

/**
 * Turn-scoped variant of {@link bashToolShellGuidance}. When the saved
 * preference is broken, dialect guidance would be a lie — every command fails
 * at the boundary — so the description declares the outage and the repair
 * instead of naming a shell that cannot run.
 */
export function bashToolTurnShellGuidance(shell: TurnShellPlan): string {
  if (!shell.setupError) return bashToolShellGuidance(shell.plan);
  return `Bash is unavailable this turn: ${shell.setupError.message} Repair the shell setting to re-enable it; commands keep failing closed rather than falling back to another shell.`;
}

function findAt(
  base: string | undefined,
  relative: string,
  fileExists: (path: string) => boolean,
): string | undefined {
  if (!base) return undefined;
  const candidate = `${base.replace(/\\+$/, '')}\\${relative}`;
  return fileExists(candidate) ? candidate : undefined;
}

function findOnWindowsPath(
  exeName: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): string | undefined {
  const pathValue = env.Path ?? env.PATH ?? env.path ?? '';
  for (const dir of pathValue.split(';')) {
    if (!dir) continue;
    const candidate = `${dir.replace(/\\+$/, '')}\\${exeName}`;
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}

function defaultFileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function isLegacyWslShim(executable: string, env: NodeJS.ProcessEnv): boolean {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (!systemRoot) return false;
  return (
    win32.normalize(executable).toLowerCase() ===
    win32.normalize(win32.join(systemRoot, 'System32', 'bash.exe')).toLowerCase()
  );
}

function requireExplicitShellExecutable(shell: ShellPlan): string {
  if (shell.exe) return shell.exe;
  throw new Error(`${shell.displayName} shell plan is missing its executable`);
}

function probeBashVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['--version'],
      { timeout: 3_000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(`${stdout}\n${stderr}`);
      },
    );
  });
}
