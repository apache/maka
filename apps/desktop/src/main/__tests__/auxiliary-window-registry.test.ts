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
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createAuxiliaryWindowRegistry } from '../auxiliary-window-registry.js';

test('registry applies declarations, reveal mode, destroy, and renderer parents', () => {
  class FakeWindow extends EventEmitter {
    readonly webContents = new EventEmitter();
    destroyed = false;
    visible = false;
    minimized = false;
    shown = 0;
    shownInactive = 0;
    focused = 0;

    constructor(readonly options: Electron.BrowserWindowConstructorOptions) { super(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    show() { this.shown += 1; this.visible = true; }
    showInactive() { this.shownInactive += 1; this.visible = true; }
    focus() { this.focused += 1; }
    restore() { this.minimized = false; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const registry = createAuxiliaryWindowRegistry(() => ({ BrowserWindow: FakeWindow } as never));
  const overlay = registry.create('permission-overlay', { title: 'Maka' }) as unknown as FakeWindow;

  assert.deepEqual(overlay.options, { title: 'Maka', show: false });

  registry.show('permission-overlay', overlay as never, 'hidden');
  assert.equal(overlay.shownInactive, 0);
  registry.show('permission-overlay', overlay as never, 'active');
  assert.equal(overlay.shownInactive, 1);
  overlay.visible = false;
  registry.focus(overlay as never, 'active');
  assert.deepEqual({ shown: overlay.shown, focused: overlay.focused }, { shown: 1, focused: 1 });

  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const parent = { kind: 'workhub-container' };
  registry.registerRenderer(contents as never, parent as never);
  assert.equal(registry.rendererParent(contents as never), parent);
  contents.emit('destroyed');
  assert.equal(registry.rendererParent(contents as never), undefined);

  registry.destroy(overlay as never);
  assert.equal(overlay.destroyed, true);
});
