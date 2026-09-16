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
import { describe, it } from 'node:test';
import { inactiveWindowPlatformArgs, isCiLinuxDisplay } from './fixture-env.mjs';

describe('inactiveWindowPlatformArgs', () => {
  it('keeps a native Wayland session on XWayland', () => {
    // showInactive() is unsupported on native Wayland, so a window revealed
    // inactively there may never appear.
    assert.deepEqual(inactiveWindowPlatformArgs({ XDG_SESSION_TYPE: 'wayland' }, 'linux'), [
      '--ozone-platform=x11',
    ]);
    assert.deepEqual(inactiveWindowPlatformArgs({ XDG_SESSION_TYPE: 'Wayland' }, 'linux'), [
      '--ozone-platform=x11',
    ]);
  });

  it("leaves every other launch on Electron's platform default", () => {
    assert.deepEqual(inactiveWindowPlatformArgs({ XDG_SESSION_TYPE: 'x11' }, 'linux'), []);
    assert.deepEqual(inactiveWindowPlatformArgs({}, 'linux'), []);
    // CI's Xvfb display is X11, and macOS and Windows have no ozone platform.
    assert.deepEqual(inactiveWindowPlatformArgs({ XDG_SESSION_TYPE: 'wayland' }, 'darwin'), []);
    assert.deepEqual(inactiveWindowPlatformArgs({ XDG_SESSION_TYPE: 'wayland' }, 'win32'), []);
  });

  it('returns only the extra arguments, so a launcher keeps its own', () => {
    const args = ['.', ...inactiveWindowPlatformArgs({}, 'darwin'), '--user-data-dir=/tmp/x'];
    assert.deepEqual(args, ['.', '--user-data-dir=/tmp/x']);
  });
});

describe('isCiLinuxDisplay', () => {
  it('is the isolated CI Linux display and nothing else', () => {
    assert.equal(isCiLinuxDisplay({ CI: '1' }, 'linux'), true);
    assert.equal(isCiLinuxDisplay({}, 'linux'), false);
    assert.equal(isCiLinuxDisplay({ CI: '1' }, 'darwin'), false);
  });
});
