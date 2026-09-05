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
import test from 'node:test';
import { BrowserOriginLeaseTracker } from '../browser/browser-origin-lease.js';

test('a navigate lease allows the old page but only arms for its approved target', () => {
  let url = 'https://old.example/';
  const tracker = new BrowserOriginLeaseTracker(() => url);
  const lease = tracker.open('https://approved.example/path', 'navigate');
  assert.equal(lease.snapshot().violatedUrl, undefined);
  assert.throws(
    () => lease.startNavigation('https://other.example/path'),
    /outside the approved Origin/u,
  );

  lease.startNavigation('https://approved.example/next');
  url = 'https://approved.example/next';
  tracker.recordNavigation(url);
  assert.deepEqual(lease.snapshot(), {
    epoch: 1,
    url: 'https://approved.example/next',
  });
});
