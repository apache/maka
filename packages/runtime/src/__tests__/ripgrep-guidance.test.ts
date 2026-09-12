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
import { hostname } from 'node:os';
import { test } from 'node:test';

import {
  currentRipgrepEnvironment,
  formatRipgrepEnvironmentArg,
  parseRipgrepEnvironmentArg,
  ripgrepMissingMessage,
  ripgrepMissingOnPathMessage,
  ripgrepVanishedMessage,
} from '../ripgrep-guidance.js';

test('only a WSL distribution names where the Host runs', () => {
  assert.deepEqual(currentRipgrepEnvironment({ WSL_DISTRO_NAME: 'Ubuntu-24.04' }), {
    kind: 'wsl',
    name: 'Ubuntu-24.04',
  });
  assert.equal(currentRipgrepEnvironment({}), undefined);
  assert.equal(currentRipgrepEnvironment({ WSL_DISTRO_NAME: '  ' }), undefined);
});

test('the environment survives the worker launch argument', () => {
  const environment = { kind: 'wsl', name: 'Ubuntu-24.04' } as const;
  assert.deepEqual(
    parseRipgrepEnvironmentArg(formatRipgrepEnvironmentArg(environment)),
    environment,
  );
  assert.equal(parseRipgrepEnvironmentArg(undefined), undefined);
  assert.equal(parseRipgrepEnvironmentArg('machine:build-host'), undefined);
});

test('every missing-ripgrep message says where to install it and to retry, never to restart', () => {
  const wsl = { kind: 'wsl', name: 'Ubuntu-24.04' } as const;
  for (const message of [
    ripgrepMissingOnPathMessage(wsl, 'linux'),
    ripgrepMissingMessage(wsl, 'linux'),
    ripgrepVanishedMessage('/usr/local/Cellar/ripgrep/14.1.0/bin/rg', wsl),
  ]) {
    assert.match(message, /the WSL distribution "Ubuntu-24\.04"/);
    assert.match(message, /then retry\.$/);
    assert.doesNotMatch(message, /restart/i);
  }
  for (const message of [
    ripgrepMissingOnPathMessage(undefined, 'darwin'),
    ripgrepMissingMessage(undefined, 'darwin'),
    ripgrepVanishedMessage('/opt/homebrew/Cellar/ripgrep/14.1.0/bin/rg', undefined),
  ]) {
    assert.match(
      message,
      /the machine this Maka Host runs on \(for a remote Host, that server rather than this computer\)/,
    );
    assert.match(message, /then retry\.$/);
    assert.doesNotMatch(message, /restart/i);
  }
});

test('the guidance never carries the machine name to the model', () => {
  const machine = hostname().trim();
  if (machine.length < 4) return;
  for (const message of [
    ripgrepMissingOnPathMessage(currentRipgrepEnvironment({})),
    ripgrepMissingMessage(currentRipgrepEnvironment({})),
    ripgrepVanishedMessage('/usr/bin/rg', currentRipgrepEnvironment({})),
  ]) {
    assert.equal(message.includes(machine), false);
  }
});
