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

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertRuntimeHostProviderDefinition } from './runtime-host-lifecycle-provider.js';
import { ownWindowsRuntimeHostProcessTree } from './runtime-host-windows-service.js';

const RESTART_DELAY_MS = 2_000;
const [mode, ...encodedCommand] = process.argv.slice(2);

try {
  const command = decodeCommand(encodedCommand);
  assertRuntimeHostProviderDefinition({ command });
  if (process.platform !== 'win32' || (mode !== '--once' && mode !== '--supervise')) {
    throw new Error('The Windows Runtime Host task command is invalid');
  }
  if (
    mode === '--supervise' &&
    (command.length < 4 || command[2] !== 'runtime-host' || command[3] !== 'serve')
  ) {
    throw new Error('The Windows Runtime Host supervisor command is invalid');
  }
  await ownWindowsRuntimeHostProcessTree(fileURLToPath(import.meta.url));
  if (mode === '--once') {
    const result = await runChild(command);
    process.exitCode = result.signal === null && result.code !== null ? result.code : 1;
  } else {
    for (;;) {
      const result = await runChild(command);
      if (result.code === 0 && result.signal === null) break;
      console.error(
        `[runtime-host] Host exited unexpectedly (${result.signal ?? result.code ?? 'launch failed'}); restarting`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}

function decodeCommand(encoded: readonly string[]): [string, ...string[]] {
  const command = encoded.map((argument) => {
    if (!/^[A-Za-z0-9_-]+$/u.test(argument)) {
      throw new Error('The Windows Runtime Host task argument is invalid');
    }
    const bytes = Buffer.from(argument, 'base64url');
    if (bytes.toString('base64url') !== argument) {
      throw new Error('The Windows Runtime Host task argument is invalid');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  });
  if (command.length === 0) {
    throw new Error('The Windows Runtime Host task command is empty');
  }
  return command as [string, ...string[]];
}

function runChild(
  childCommand: readonly [string, ...string[]],
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const child = spawn(childCommand[0], childCommand.slice(1), {
      stdio: 'inherit',
      windowsHide: true,
    });
    let settled = false;
    child.once('error', () => {
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: null });
      }
    });
    child.once('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        resolve({ code, signal });
      }
    });
  });
}
