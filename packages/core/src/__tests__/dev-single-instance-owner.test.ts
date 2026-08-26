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
import {
  describeDevProfileOwner,
  parseDevProfileLockTarget,
  resolveLiveDevProfileOwner,
} from '../dev-single-instance-owner.js';

test('parse reads hostname and pid by splitting from the end', () => {
  // Observed real-machine format: bare `<hostname>-<pid>`.
  assert.deepEqual(parseDevProfileLockTarget('macbookair.home-739'), {
    hostname: 'macbookair.home',
    pid: 739,
  });
});

test('parse keeps dashed hostnames intact because the pid is the final segment', () => {
  assert.deepEqual(parseDevProfileLockTarget('my-mac-book.local-42'), {
    hostname: 'my-mac-book.local',
    pid: 42,
  });
});

test('parse takes the final path segment of path-shaped targets', () => {
  assert.deepEqual(
    parseDevProfileLockTarget('/Users/dev/Library/Application Support/Maka Dev-192.168.0.2-5'),
    { hostname: 'Maka Dev-192.168.0.2', pid: 5 },
  );
});

test('parse rejects malformed targets instead of guessing', () => {
  assert.equal(parseDevProfileLockTarget(''), undefined);
  assert.equal(parseDevProfileLockTarget('   '), undefined);
  assert.equal(parseDevProfileLockTarget('no-dash-at-all'), undefined);
  assert.equal(parseDevProfileLockTarget('-123'), undefined);
  assert.equal(parseDevProfileLockTarget('host-'), undefined);
  assert.equal(parseDevProfileLockTarget('host-notapid'), undefined);
  assert.equal(parseDevProfileLockTarget('host-12x'), undefined);
});

const alive = () => true;
const dead = () => false;

test('resolve reports a live local holder from an injected lock target', () => {
  const owner = resolveLiveDevProfileOwner('/profile', {
    readLockTarget: () => 'mac.local-739',
    liveness: alive,
    localHostname: 'Mac.Local',
  });
  assert.deepEqual(owner, { hostname: 'mac.local', pid: 739, isLocalHost: true });
  assert.equal(describeDevProfileOwner(owner!), 'PID 739 on this machine');
});

test('resolve flags foreign-host records without treating them as local pids', () => {
  const owner = resolveLiveDevProfileOwner('/profile', {
    readLockTarget: () => 'other-box-739',
    liveness: alive,
    localHostname: 'mac.local',
  });
  assert.deepEqual(owner, { hostname: 'other-box', pid: 739, isLocalHost: false });
  assert.equal(describeDevProfileOwner(owner!), 'PID 739 on host "other-box"');
});

test('resolve returns undefined for a stale symlink whose pid is gone', () => {
  const owner = resolveLiveDevProfileOwner('/profile', {
    readLockTarget: () => 'mac.local-739',
    liveness: dead,
    localHostname: 'mac.local',
  });
  assert.equal(owner, undefined);
});

test('resolve degrades to undefined on unreadable, missing, or malformed locks', () => {
  assert.equal(
    resolveLiveDevProfileOwner('/profile', { readLockTarget: () => undefined }),
    undefined,
  );
  assert.equal(
    resolveLiveDevProfileOwner('/profile', {
      readLockTarget: () => {
        throw new Error('ENOENT');
      },
    }),
    undefined,
  );
  assert.equal(
    resolveLiveDevProfileOwner('/profile', { readLockTarget: () => 'garbage' }),
    undefined,
  );
});

test('a probe that throws is treated as no trustworthy holder', () => {
  const owner = resolveLiveDevProfileOwner('/profile', {
    readLockTarget: () => 'mac.local-739',
    liveness: () => {
      throw new Error('boom');
    },
    localHostname: 'mac.local',
  });
  assert.equal(owner, undefined);
});
