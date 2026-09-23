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

import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EXTENSION_ID, EXTENSION_STORE_URL } from 'opencli-mcp/dist/src/host/extension.js';
import { nativeHostDirs, runningProfileDirs } from 'opencli-mcp/dist/src/host/registration.js';
import { hostHealth, readHostState } from 'opencli-mcp/dist/src/host/state.js';
import { NATIVE_HOST_NAME } from 'opencli-mcp/dist/src/protocol.js';
import type { OpencliChromeStatus } from '../shared/opencli-chrome.js';

export interface OpencliChrome {
  status(): Promise<OpencliChromeStatus>;
  /** Registers the Native Messaging host with Chrome, then opens the
   * extension's store page unless the extension is already connected. */
  connect(): Promise<void>;
}

export interface OpencliLaunchers {
  /** Stdio MCP server, the command stored in mcp.json. */
  command: string;
  /** Native Messaging host that Chrome starts for the extension. */
  host: string;
}

/**
 * The launchers live at fixed paths under Maka's own state and are rewritten
 * on every start, so mcp.json and Chrome's host manifest never hold the
 * executable path itself — that moves on every AppImage launch.
 */
export function writeOpencliLaunchers(
  dir: string,
  platform: NodeJS.Platform,
  executable: string,
  entry: string,
): OpencliLaunchers {
  mkdirSync(dir, { recursive: true });
  const write = (name: string, args: string): string => {
    if (platform === 'win32') {
      const file = join(dir, `${name}.cmd`);
      writeFileSync(file, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${executable}" "${entry}" ${args}\r\n`);
      return file;
    }
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(executable)} ${shellQuote(entry)} ${args}\n`, { mode: 0o755 });
    return file;
  };
  return { command: write('opencli-mcp', 'stdio'), host: write('opencli-mcp-host', 'host --native') };
}

export interface NativeHostTarget {
  browser: string;
  dir: string;
}

/**
 * Chrome is registered even before its first launch, other browsers only once
 * their profile exists. A manifest pointing at another live install, such as
 * a global `opencli-mcp setup`, is left alone: the stdio server reaches
 * whichever host Chrome starts.
 */
export function registerOpencliNativeHost(
  host: string,
  targets: readonly NativeHostTarget[],
  platform: NodeJS.Platform,
): string[] {
  const manifest = JSON.stringify({
    name: NATIVE_HOST_NAME,
    description: 'opencli-mcp browser runtime host',
    path: host,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  }, null, 2);
  const written: string[] = [];
  for (const target of targets) {
    if (target.browser !== 'chrome' && !target.browser.startsWith('profile:') && !existsSync(dirname(target.dir))) continue;
    const file = join(target.dir, `${NATIVE_HOST_NAME}.json`);
    if (ownedByAnotherInstall(file, host)) continue;
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(file, manifest);
    if (platform === 'win32') {
      execFileSync('reg', ['add', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { stdio: 'pipe' });
    }
    written.push(file);
  }
  return written;
}

export function createOpencliChrome(stateDir: string, openExternal: (url: string) => Promise<void>): OpencliChrome {
  const entry = fileURLToPath(import.meta.resolve('opencli-mcp/dist/src/main.js'));
  const launchers = writeOpencliLaunchers(join(stateDir, 'opencli-mcp'), process.platform, process.execPath, entry);
  const status = async (): Promise<OpencliChromeStatus> => {
    const health = await hostHealth(readHostState());
    return { command: launchers.command, connected: health.ok && health.extensionConnected === true };
  };
  return {
    status,
    async connect() {
      const targets = [
        ...nativeHostDirs(),
        ...runningProfileDirs().map((dir) => ({ browser: `profile:${dir}`, dir: join(dir, 'NativeMessagingHosts') })),
      ];
      registerOpencliNativeHost(launchers.host, targets, process.platform);
      if ((await status()).connected) return;
      await openInChrome(EXTENSION_STORE_URL, openExternal);
    },
  };
}

function ownedByAnotherInstall(file: string, host: string): boolean {
  try {
    const path = (JSON.parse(readFileSync(file, 'utf8')) as { path?: unknown }).path;
    return typeof path === 'string' && path !== host && existsSync(path);
  } catch {
    return false;
  }
}

// The default browser may not be Chrome, and only Chrome can install it.
async function openInChrome(url: string, openExternal: (url: string) => Promise<void>): Promise<void> {
  const launches = process.platform === 'darwin' ? [() => promisify(execFile)('open', ['-a', 'Google Chrome', url])]
    : process.platform === 'linux' ? ['google-chrome', 'chromium'].map((command) => () => startDetached(command, [url]))
    : [];
  for (const launch of launches) {
    try {
      await launch();
      return;
    } catch {
      // Not installed under this name; try the next, then the default browser.
    }
  }
  await openExternal(url);
}

// A browser started here may run for the rest of the session.
function startDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
