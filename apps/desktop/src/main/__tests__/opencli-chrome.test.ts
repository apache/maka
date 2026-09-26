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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { openInChrome, registerOpencliNativeHost, writeOpencliLaunchers } from '../opencli-chrome.js';

test('launchers run the entry in Node mode with the mode each caller needs', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), "maka opencli '"));
  const entry = join(root, 'entry.mjs');
  writeFileSync(entry, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE }));');
  const launchers = writeOpencliLaunchers(join(root, 'bin'), process.platform, process.execPath, entry);

  assert.deepEqual(JSON.parse(execFileSync(launchers.command, { encoding: 'utf8' })), { args: ['stdio'], node: '1' });
  // Chrome appends the calling extension's origin.
  assert.deepEqual(
    JSON.parse(execFileSync(launchers.host, ['chrome-extension://id/'], { encoding: 'utf8' })),
    { args: ['host'], node: '1' },
  );
});

test('Windows launchers set Node mode before starting the entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-opencli-'));
  const launchers = writeOpencliLaunchers(dir, 'win32', 'C:\\Maka\\Maka.exe', 'C:\\Maka\\main.js');
  assert.equal(launchers.command, join(dir, 'opencli-mcp.cmd'));
  assert.equal(
    readFileSync(launchers.host, 'utf8'),
    '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Maka\\Maka.exe" "C:\\Maka\\main.js" host\r\n',
  );
});

test('the host manifest goes to Chrome and existing browsers, never over another live install', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-opencli-'));
  const host = join(root, 'opencli-mcp-host');
  // The launcher format of a global `opencli-mcp setup`.
  const globalLauncher = (name: string, main: string) => {
    const file = join(root, name);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${main}" host\n`);
    return file;
  };
  const liveMain = join(root, 'global', 'main.js');
  mkdirSync(dirname(liveMain));
  writeFileSync(liveMain, '');
  const other = globalLauncher('global-opencli-mcp-host', liveMain);
  const dir = (name: string) => join(root, name, 'NativeMessagingHosts');
  const manifest = (name: string) => join(dir(name), 'com.opencli.mcp.json');
  mkdirSync(dir('brave'), { recursive: true });
  writeFileSync(manifest('brave'), JSON.stringify({ path: other }));
  mkdirSync(dir('chromium'), { recursive: true });
  writeFileSync(manifest('chromium'), JSON.stringify({ path: globalLauncher('uninstalled-opencli-mcp-host', join(root, 'uninstalled', 'main.js')) }));
  mkdirSync(dir('profile'), { recursive: true });
  writeFileSync(manifest('profile'), JSON.stringify({ path: join(root, 'removed-host') }));

  const written = registerOpencliNativeHost(host, [
    { browser: 'chrome', dir: dir('chrome') },
    { browser: 'edge', dir: dir('edge') },
    { browser: 'brave', dir: dir('brave') },
    { browser: 'chromium', dir: dir('chromium') },
    { browser: `profile:${root}`, dir: dir('profile') },
  ], 'darwin');

  assert.deepEqual(written, [manifest('chrome'), manifest('chromium'), manifest('profile')]);
  assert.equal(JSON.parse(readFileSync(manifest('chromium'), 'utf8')).path, host);
  assert.deepEqual(JSON.parse(readFileSync(manifest('chrome'), 'utf8')), {
    name: 'com.opencli.mcp',
    description: 'opencli-mcp browser runtime host',
    path: host,
    type: 'stdio',
    allowed_origins: ['chrome-extension://lnaoghmfcdnbhgcihkakfobckmfhllkg/'],
  });
  assert.equal(JSON.parse(readFileSync(manifest('brave'), 'utf8')).path, other);
});

// The stand-in chrome.exe is a shell script, which Windows cannot run.
test('Windows opens the store page in installed Chrome, not the default browser', { skip: process.platform === 'win32' }, async () => {
  const local = mkdtempSync(join(tmpdir(), 'maka-opencli-'));
  const chrome = join(local, 'Google', 'Chrome', 'Application', 'chrome.exe');
  const received = join(local, 'received-url');
  mkdirSync(dirname(chrome), { recursive: true });
  writeFileSync(chrome, `#!/bin/sh\nprintf '%s' "$1" > '${received}'\n`, { mode: 0o755 });
  const url = 'https://chromewebstore.google.com/detail/opencli';
  const defaultBrowser: string[] = [];
  const openExternal = async (target: string) => {
    defaultBrowser.push(target);
  };

  await openInChrome(url, openExternal, 'win32', { PROGRAMFILES: join(local, 'missing'), LOCALAPPDATA: local });
  for (let waited = 0; !existsSync(received) && waited < 5_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(readFileSync(received, 'utf8'), url);
  assert.deepEqual(defaultBrowser, []);

  await openInChrome(url, openExternal, 'win32', { LOCALAPPDATA: join(local, 'missing') });
  assert.deepEqual(defaultBrowser, [url]);
});
