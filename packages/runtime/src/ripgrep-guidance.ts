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
 * path ran the search. The Windows sandbox refusal deliberately stays in the
 * worker: that is a capability limit of the AppContainer, not a missing
 * dependency.
 */

const RIPGREP_INSTALL_URL = 'https://github.com/BurntSushi/ripgrep#installation';

function ripgrepInstallHint(platform: NodeJS.Platform): string {
  const command =
    platform === 'darwin'
      ? '`brew install ripgrep`'
      : platform === 'win32'
        ? '`winget install BurntSushi.ripgrep.MSVC`'
        : 'your package manager (for example `apt install ripgrep`)';
  return `Install it with ${command}, or see ${RIPGREP_INSTALL_URL}.`;
}

/** The local executor looks `rg` up on PATH at every call, so a retry suffices. */
export function ripgrepMissingOnPathMessage(platform: NodeJS.Platform = process.platform): string {
  return `Grep requires ripgrep (\`rg\`), which was not found on PATH. ${ripgrepInstallHint(platform)} Then retry.`;
}

/** The worker resolves ripgrep once, when the runtime starts. */
export function ripgrepMissingAtStartupMessage(
  platform: NodeJS.Platform = process.platform,
): string {
  return `Grep requires ripgrep (\`rg\`), but no usable copy was found when Maka started. ${ripgrepInstallHint(platform)} Then restart Maka.`;
}

/** The executable resolved at startup is gone (e.g. a package upgrade removed it). */
export function ripgrepVanishedMessage(executable: string): string {
  return `Grep could not start ripgrep at ${executable}; it was moved or removed after Maka started (for example by a package upgrade). Reinstall ripgrep if needed, then restart Maka.`;
}

/** Local-executor twin of the worker protocol's `grep_unavailable` error. */
export class RipgrepUnavailableError extends Error {
  readonly code = 'grep_unavailable';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RipgrepUnavailableError';
  }
}
