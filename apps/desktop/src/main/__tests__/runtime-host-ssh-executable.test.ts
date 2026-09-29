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
import { test } from 'node:test';
import { resolveSshTerminalExecutable } from '../runtime-host-ssh-executable.js';

test('returns the bare executable outside Windows', () => {
  assert.equal(resolveSshTerminalExecutable('ssh', { platform: 'darwin' }), 'ssh');
  assert.equal(resolveSshTerminalExecutable('scp', { platform: 'linux' }), 'scp');
});

test('prefers the system OpenSSH install on Windows', () => {
  const resolved = resolveSshTerminalExecutable('ssh', {
    platform: 'win32',
    arch: 'x64',
    environment: {
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Tools',
    },
    existsSync: (path) => path === 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
  });
  assert.equal(resolved, 'C:\\Windows\\System32\\OpenSSH\\ssh.exe');
});

test('resolves scp next to ssh on Windows', () => {
  const resolved = resolveSshTerminalExecutable('scp', {
    platform: 'win32',
    arch: 'x64',
    environment: { SystemRoot: 'C:\\Windows' },
    existsSync: (path) => path === 'C:\\Windows\\System32\\OpenSSH\\scp.exe',
  });
  assert.equal(resolved, 'C:\\Windows\\System32\\OpenSSH\\scp.exe');
});

test('reaches the 64-bit System32 from a 32-bit process through Sysnative', () => {
  const seen: string[] = [];
  const resolved = resolveSshTerminalExecutable('ssh', {
    platform: 'win32',
    arch: 'ia32',
    environment: { SystemRoot: 'C:\\Windows' },
    existsSync: (path) => {
      seen.push(path);
      return path === 'C:\\Windows\\Sysnative\\OpenSSH\\ssh.exe';
    },
  });
  assert.equal(resolved, 'C:\\Windows\\Sysnative\\OpenSSH\\ssh.exe');
  assert.ok(!seen.includes('C:\\Windows\\System32\\OpenSSH\\ssh.exe'));
});

test('falls back to PATH entries quoted or not when OpenSSH is installed elsewhere', () => {
  const resolved = resolveSshTerminalExecutable('ssh', {
    platform: 'win32',
    arch: 'x64',
    environment: {
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Missing;"C:\\Program Files\\Git\\usr\\bin";',
    },
    existsSync: (path) => path === 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
  });
  assert.equal(resolved, 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe');
});

test('reads case-variant environment names on Windows', () => {
  const resolved = resolveSshTerminalExecutable('ssh', {
    platform: 'win32',
    arch: 'x64',
    environment: {
      SYSTEMROOT: 'C:\\Windows',
      PATH: 'C:\\Tools',
    },
    existsSync: (path) => path === 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
  });
  assert.equal(resolved, 'C:\\Windows\\System32\\OpenSSH\\ssh.exe');
});

test('throws an actionable error when no ssh.exe can be found on Windows', () => {
  assert.throws(
    () =>
      resolveSshTerminalExecutable('ssh', {
        platform: 'win32',
        arch: 'x64',
        environment: { SystemRoot: 'C:\\Windows', Path: 'C:\\Tools' },
        existsSync: () => false,
      }),
    /Unable to find ssh\.exe.*OpenSSH Client.*on PATH/u,
  );
  assert.throws(
    () =>
      resolveSshTerminalExecutable('scp', {
        platform: 'win32',
        arch: 'x64',
        environment: {},
        existsSync: () => {
          throw new Error('EACCES');
        },
      }),
    /Unable to find scp\.exe/u,
  );
});
