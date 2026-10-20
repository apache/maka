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
import { runInNewContext } from 'node:vm';
import { MAIN_WINDOW_DROP_GUARD_SCRIPT } from '../main-window-drop-guard.js';

class DropTarget {
  constructor(private readonly selector: string) {}
  closest(selector: string) { return selector === this.selector ? this : null; }
}

function dispatchDropGuard(type: string, target: unknown, types: string[]) {
  const listeners = new Map<string, (event: unknown) => void>();
  runInNewContext(MAIN_WINDOW_DROP_GUARD_SCRIPT, {
    Element: DropTarget,
    window: {
      addEventListener(type: string, listener: (event: unknown) => void, capture: boolean) {
        assert.equal(capture, true);
        listeners.set(type, listener);
      },
    },
  });
  let prevented = false;
  let stopped = false;
  listeners.get(type)!({
    target,
    dataTransfer: { types },
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  });
  return { prevented, stopped };
}

for (const type of ['dragover', 'drop']) {
  test(`${type}: session payload reaches a project target through the window guard`, () => {
    const project = new DropTarget('[data-maka-session-drop-target="true"]');
    for (const target of [project, { parentElement: project }]) {
      assert.deepEqual(dispatchDropGuard(type, target, ['application/x-maka-session']), {
        prevented: false, stopped: false,
      });
    }
  });

  test(`${type}: files and foreign text remain blocked on project targets`, () => {
    const project = new DropTarget('[data-maka-session-drop-target="true"]');
    for (const types of [['Files'], ['text/plain'], []]) {
      assert.deepEqual(dispatchDropGuard(type, project, types), {
        prevented: true, stopped: true,
      });
    }
  });

  test(`${type}: session drops outside a move target remain blocked`, () => {
    for (const target of [new DropTarget('body'), null]) {
      assert.deepEqual(dispatchDropGuard(type, target, ['application/x-maka-session']), {
        prevented: true, stopped: true,
      });
    }
  });

  test(`${type}: attachment and queue drop routes remain available`, () => {
    assert.deepEqual(dispatchDropGuard(type,
      new DropTarget('[data-maka-file-drop-target="true"]'), ['Files']), {
      prevented: false, stopped: false,
    });
    assert.deepEqual(dispatchDropGuard(type,
      new DropTarget('[data-maka-queue-drop-target="true"]'), ['application/x-maka-queue-entry']), {
      prevented: false, stopped: false,
    });
    assert.deepEqual(dispatchDropGuard(type,
      new DropTarget('[data-maka-queue-drop-target="true"]'), ['application/x-maka-session']), {
      prevented: true, stopped: true,
    });
  });
}
