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
import { appShellFrameStyle } from '../../renderer/shell/frame-style.js';

test('every published width stays a <length>, collapsed included', () => {
  const collapsed = appShellFrameStyle({
    sessionListCollapsed: true,
    sessionListWidth: 260,
    workbarRightWidth: 480,
  }) as Record<string, string>;
  const expanded = appShellFrameStyle({
    sessionListCollapsed: false,
    sessionListWidth: 291,
    workbarRightWidth: 480,
  }) as Record<string, string>;

  assert.equal(collapsed['--maka-sidenav-width'], '0px');
  assert.equal(expanded['--maka-sidenav-width'], '291px');
  assert.equal(collapsed['--maka-session-workbar-width'], '480px');
});
