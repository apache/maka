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

/**
 * Grep's only engine is ripgrep, and nothing ships it (#5167). These builders
 * keep the missing-ripgrep copy identical on the local executor and the
 * filesystem worker, so the model and the user learn the same fix whichever
 * path ran the search. Both paths look ripgrep up again on the next attempt —
 * the local executor on every call, the worker whenever the copy it knew is
 * missing, gone or replaced — so the recovery is always "install it where the
 * Host runs, then retry", never a restart. The Windows sandbox refusal
 * deliberately stays in the worker: that is a capability limit of the
 * AppContainer, not a missing dependency.
 *
 * The copy reaches the model as tool output, so it names a place without
 * naming the machine. A WSL distribution is an identifier Maka already keeps
 * for its Hosts; a hostname is personal (a default macOS name carries its
 * owner's name) and Maka otherwise shows it only as a device name in Desktop,
 * which already says which Host is active.
 */

const RIPGREP_INSTALL_URL = 'https://github.com/BurntSushi/ripgrep#installation';

/** The one place a Host can name about itself without naming the machine. */
export interface RipgrepEnvironment {
  readonly kind: 'wsl';
  readonly name: string;
}

export function currentRipgrepEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RipgrepEnvironment | undefined {
  const distribution = env.WSL_DISTRO_NAME?.trim();
  return distribution ? { kind: 'wsl', name: distribution } : undefined;
}

/** The worker receives its environment as a launch argument: its own environment block is scrubbed. */
export function formatRipgrepEnvironmentArg(environment: RipgrepEnvironment): string {
  return `${environment.kind}:${environment.name}`;
}

export function parseRipgrepEnvironmentArg(
  value: string | undefined,
): RipgrepEnvironment | undefined {
  const match = value ? /^wsl:(.+)$/u.exec(value) : null;
  return match ? { kind: 'wsl', name: match[1]! } : undefined;
}

function installLocation(environment: RipgrepEnvironment | undefined): string {
  return environment
    ? `the WSL distribution "${environment.name}"`
    : 'the machine this Maka Host runs on (for a remote Host, that server rather than this computer)';
}

function installInstructions(
  environment: RipgrepEnvironment | undefined,
  platform: NodeJS.Platform,
): string {
  const command =
    platform === 'darwin'
      ? '`brew install ripgrep`'
      : platform === 'win32'
        ? '`winget install BurntSushi.ripgrep.MSVC`'
        : 'your package manager (for example `apt install ripgrep`)';
  return `Install it on ${installLocation(environment)} with ${command}, or see ${RIPGREP_INSTALL_URL}, then retry.`;
}

/** The local executor looks `rg` up on PATH at every call. */
export function ripgrepMissingOnPathMessage(
  environment: RipgrepEnvironment | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  return `Grep requires ripgrep (\`rg\`), and it was not found on PATH. ${installInstructions(environment, platform)}`;
}

/** The worker was launched without a usable ripgrep; its next launch looks again. */
export function ripgrepMissingMessage(
  environment: RipgrepEnvironment | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  return `Grep requires ripgrep (\`rg\`), and no usable copy was found. ${installInstructions(environment, platform)}`;
}

/** The executable the worker was launched with is gone (e.g. a package upgrade removed it). */
export function ripgrepVanishedMessage(
  executable: string,
  environment: RipgrepEnvironment | undefined,
): string {
  return `Grep could not start ripgrep at ${executable}; it was moved or removed, for example by a package upgrade. Reinstall it on ${installLocation(environment)} if needed, then retry.`;
}

/** Local-executor twin of the worker protocol's `grep_unavailable` error. */
export class RipgrepUnavailableError extends Error {
  readonly code = 'grep_unavailable';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RipgrepUnavailableError';
  }
}
