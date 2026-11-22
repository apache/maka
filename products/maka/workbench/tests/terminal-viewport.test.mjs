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
import { registerHooks } from 'node:module';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
const native = {
  nsh: `export const signal = initial => {
      let value = initial;
      const read = () => value;
      read.set = next => { value = next; };
      return read;
    };
    export const batch = fn => fn();
    export const cleanup = () => {};`,
  locale: `export const tr = key => key;`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const key =
      context.parentURL?.startsWith(appRoot.href) && specifier === './locale'
        ? 'locale'
        : specifier;
    if (key in native)
      return { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true };
    if (
      context.parentURL?.startsWith(appRoot.href) &&
      specifier.startsWith('.') &&
      !/\.\w+$/.test(specifier)
    )
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { createTerminalViewport } = await import(new URL('terminalViewport.ts', appRoot));
hooks.deregister();

function setup(textTerminal = false) {
  const state = createTerminalViewport();
  const commands = [];
  let total = 100;
  const options = {
    lineHeight: 10,
    textTerminal,
    totalRows: () => total,
    height: () => 100,
    rows: () => 10,
    scrollTo: (y) => commands.push(y),
    scrollToEnd: () => commands.push('end'),
  };
  let view = state.attach(options);
  return {
    state,
    commands,
    get view() {
      return view;
    },
    grow() {
      total += 20;
      view.follow();
    },
    remount() {
      view = state.attach(options);
    },
    scroll(y, end = total * 10 - 100) {
      view.onScroll({ offset: { y }, contentSize: { height: end + 100 }, size: { height: 100 } });
    },
  };
}

test('late automatic scroll reports preserve following across batches', () => {
  const f = setup();
  f.scroll(900);
  f.grow();
  f.scroll(890, 900);
  f.grow();
  assert.equal(f.state.historyTop(), null);
  assert.deepEqual(f.commands, ['end', 'end']);
});

test('drag end before throttled scroll preserves history and resumes at bottom', () => {
  const f = setup();
  f.scroll(900);
  f.view.onScrollDragStart({ offset: { y: 900 } });
  f.grow();
  assert.deepEqual(f.commands, []);
  f.view.onScrollEnd({ offset: { y: 200 } });
  f.scroll(200);
  assert.equal(f.state.historyTop(), 20);
  f.grow();
  assert.deepEqual(f.commands, []);
  f.view.onScrollIntent({ intent: 'scroll', delta: 100 });
  f.scroll(1300);
  f.grow();
  assert.equal(f.state.historyTop(), null);
  assert.deepEqual(f.commands, ['end']);
});

test('paging keeps history through new output and remounts', () => {
  const f = setup();
  f.view.page(-1);
  assert.equal(f.state.historyTop(), 80);
  assert.deepEqual(f.commands, [800]);
  f.grow();
  f.remount();
  f.view.follow();
  assert.equal(f.state.historyTop(), 80);
  assert.deepEqual(f.commands, [800]);
  f.view.page(1);
  f.view.page(1);
  f.view.page(1);
  f.view.follow();
  assert.equal(f.state.historyTop(), null);
  assert.deepEqual(f.commands, [800, 900, 1000, 'end']);
});

test('remount clears a drag without resetting the saved position', () => {
  const f = setup();
  f.view.onScrollDragStart({ offset: { y: 900 } });
  f.remount();
  f.view.follow();
  assert.equal(f.state.position.y, 900);
  assert.deepEqual(f.commands, ['end']);
});

test('text terminal retains its automatic return-to-bottom behavior', () => {
  for (const textTerminal of [false, true]) {
    const f = setup(textTerminal);
    f.view.page(-1);
    f.scroll(900);
    assert.equal(f.state.historyTop(), textTerminal ? null : 90);
  }
});
