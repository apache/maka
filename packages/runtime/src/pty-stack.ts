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

import type * as NodePty from 'node-pty';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Unicode11Addon as HeadlessUnicode11Addon } from '@xterm/addon-unicode11';

export interface PtyStack {
  spawn: typeof NodePty.spawn;
  Terminal: typeof HeadlessTerminal;
  Unicode11Addon: typeof HeadlessUnicode11Addon;
}

let loadPromise: Promise<PtyStack> | undefined;

export function loadPtyStack(): Promise<PtyStack> {
  loadPromise ??= loadAndValidatePtyStack().catch((error: unknown) => {
    throw new Error(
      `PTY support failed to load for ${process.platform}/${process.arch}: ${errorMessage(error)}`,
      { cause: error },
    );
  });
  return loadPromise;
}

async function loadAndValidatePtyStack(): Promise<PtyStack> {
  const [nodePty, headless, unicode11] = await Promise.all([
    import('node-pty'),
    import('@xterm/headless'),
    import('@xterm/addon-unicode11'),
  ]);
  const spawn =
    (
      nodePty as unknown as {
        spawn?: typeof NodePty.spawn;
        default?: { spawn?: typeof NodePty.spawn };
      }
    ).spawn ?? nodePty.default?.spawn;
  const Terminal =
    (
      headless as unknown as {
        Terminal?: typeof HeadlessTerminal;
        default?: { Terminal?: typeof HeadlessTerminal };
      }
    ).Terminal ??
    (headless as unknown as { default?: { Terminal?: typeof HeadlessTerminal } }).default?.Terminal;
  const Unicode11Addon =
    (
      unicode11 as unknown as {
        Unicode11Addon?: typeof HeadlessUnicode11Addon;
        default?: { Unicode11Addon?: typeof HeadlessUnicode11Addon };
      }
    ).Unicode11Addon ??
    (unicode11 as unknown as { default?: { Unicode11Addon?: typeof HeadlessUnicode11Addon } })
      .default?.Unicode11Addon;
  if (typeof spawn !== 'function') throw new Error('node-pty does not export spawn');
  if (typeof Terminal !== 'function') throw new Error('@xterm/headless does not export Terminal');
  if (typeof Unicode11Addon !== 'function') {
    throw new Error('@xterm/addon-unicode11 does not export Unicode11Addon');
  }
  return {
    spawn,
    Terminal,
    Unicode11Addon,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
