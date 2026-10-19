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
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runInThisContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ptyLib = dirname(require.resolve('node-pty'));

// Load the installed Windows implementation on every host, controlling only
// the native process callback and sockets to exercise both event orders.
async function windowsTerminal() {
  class Socket extends EventEmitter {
    readable = true;
    destroyed = false;
    setEncoding() {}
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('close');
    }
  }
  let nativeExit: (code: number) => void = () => {
    throw new Error('Native process has not connected');
  };
  const native = {
    startProcess: () => ({ fd: 1, pty: 1, conin: 'input', conout: 'output' }),
    connect: (...args: unknown[]) => {
      nativeExit = args[5] as (code: number) => void;
      return { pid: 123 };
    },
  };
  class ConoutConnection {
    onReady(listener: () => void) {
      queueMicrotask(listener);
    }
    onError() {}
    connectSocket(socket: Socket) {
      socket.emit('connect');
    }
  }
  function load(name: string): Record<string, unknown> {
    const path = join(ptyLib, `${name}.js`);
    const module = { exports: {} };
    const localRequire = createRequire(path);
    const controlledRequire = (id: string) => {
      if (id === './windowsPtyAgent') return load('windowsPtyAgent');
      if (id === './windowsConoutConnection') return { ConoutConnection };
      if (id === './utils') {
        return { ...localRequire(id), loadNativeModule: () => ({ module: native }) };
      }
      if (id === 'net') return { Socket };
      if (id === 'fs') return { ...localRequire(id), openSync: () => 1 };
      return localRequire(id);
    };
    runInThisContext(`(function(require, module, exports) {\n${readFileSync(path, 'utf8')}\n})`, {
      filename: path,
    })(controlledRequire, module, module.exports);
    return module.exports;
  }
  const { WindowsTerminal } = load('windowsTerminal') as {
    WindowsTerminal: new (
      command: string,
    ) => {
      onExit: (listener: (event: { exitCode: number }) => void) => void;
      _socket: Socket;
      _agent: { _closeTimeout?: NodeJS.Timeout };
    };
  };
  const terminal = new WindowsTerminal('node.exe');
  await Promise.resolve();
  return {
    terminal,
    exit: (code: number) => nativeExit(code),
    cleanup: () => clearTimeout(terminal._agent._closeTimeout),
  };
}

test('Windows PTY reports the native exit code after both process exit and output close', async () => {
  for (const pipeFirst of [true, false]) {
    for (const code of [0, 7]) {
      const fixture = await windowsTerminal();
      const exits: number[] = [];
      fixture.terminal.onExit(({ exitCode }) => exits.push(exitCode));
      try {
        const close = () => fixture.terminal._socket.destroy();
        const exit = () => fixture.exit(code);
        (pipeFirst ? close : exit)();
        assert.deepEqual(exits, [], 'one event alone must not report process completion');
        (pipeFirst ? exit : close)();
        assert.deepEqual(exits, [code], 'report the real code exactly once');
      } finally {
        fixture.cleanup();
      }
    }
  }
});
