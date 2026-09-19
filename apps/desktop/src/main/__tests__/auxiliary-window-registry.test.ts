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

test('registry applies declarations, reveal mode, theme, destroy, and renderer parents', () => {
  class FakeWindow extends EventEmitter {
    readonly webContents = new EventEmitter();
    destroyed = false;
    visible = false;
    minimized = false;
    shown = 0;
    shownInactive = 0;
    focused = 0;
    colors: string[] = [];

    constructor(readonly options: Electron.BrowserWindowConstructorOptions) { super(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    show() { this.shown += 1; this.visible = true; }
    showInactive() { this.shownInactive += 1; this.visible = true; }
    focus() { this.focused += 1; }
    restore() { this.minimized = false; }
    setBackgroundColor(color: string) { this.colors.push(color); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const registry = createAuxiliaryWindowRegistry(() => ({ BrowserWindow: FakeWindow, nativeTheme } as never));
  const startup = registry.create('startup-progress', { title: 'Maka' }) as unknown as FakeWindow;

  assert.deepEqual(startup.options, {
    width: 520, height: 350, useContentSize: true, title: 'Maka', show: false,
  });
  assert.deepEqual(startup.colors, ['#ffffff']);
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.emit('updated');
  assert.deepEqual(startup.colors, ['#ffffff', '#1c1d21']);

  registry.show('startup-progress', startup as never, 'hidden');
  assert.equal(startup.shownInactive, 0);
  registry.show('startup-progress', startup as never, 'active');
  assert.equal(startup.shownInactive, 1);
  startup.visible = false;
  registry.focus(startup as never, 'active');
  assert.deepEqual({ shown: startup.shown, focused: startup.focused }, { shown: 1, focused: 1 });

  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const parent = { kind: 'workhub-container' };
  registry.registerRenderer(contents as never, parent as never);
  assert.equal(registry.rendererParent(contents as never), parent);
  contents.emit('destroyed');
  assert.equal(registry.rendererParent(contents as never), undefined);

  registry.destroy(startup as never);
  assert.equal(startup.destroyed, true);
});
