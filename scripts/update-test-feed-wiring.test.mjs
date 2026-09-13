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
 * `verify-windows-autoupdate.mjs` drives the packaged updater by handing it
 * `MAKA_UPDATE_TEST_FEED`, and the boot path is what carries that value to the
 * update service. Break the wiring and the packaged run stops reaching the
 * harness feed, so the verifier proves nothing while still passing.
 *
 * The wiring is a handful of lines. Asserting them costs milliseconds on every
 * change, which is why naming their 1900-line module in the packaged Windows
 * lane's path filter — a 25-minute Windows job — was the wrong instrument.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const FEED = 'MAKA_UPDATE_TEST_FEED';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('the packaged boot path hands the harness feed to the update service', () => {
  const boot = read('apps/desktop/src/main/runtime-host-boot.ts');

  assert.match(boot, /const updateTestFeed = process\.env\.MAKA_UPDATE_TEST_FEED;/u);
  // Bounded to the call's own argument object — the span may not cross a `});`
  // — because an unbounded `[\s\S]*?` would accept a `testFeedUrl` belonging to
  // some later call several hundred lines away.
  assert.match(
    boot,
    /createAppUpdateService\(\{(?:(?!\}\);)[\s\S])*?testFeedUrl: updateTestFeed,/u,
  );
});

test('the harness feed still redirects packaged user data away from the real root', () => {
  // Without this the update test would write into the developer's own profile.
  const main = read('apps/desktop/src/main/main.ts');

  assert.match(
    main,
    /resolveUpdateTestUserDataDirectory\(\{\n\s+feedUrl: process\.env\.MAKA_UPDATE_TEST_FEED,/u,
  );
});

test('the Windows autoupdate verifier is what supplies the feed', () => {
  const verifier = read('scripts/verify-windows-autoupdate.mjs');

  assert.match(verifier, new RegExp(`${FEED}: feed\\.url`, 'u'));
});
