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

import { createTerminalViewport } from '../../../workbench/app/terminalViewport';
import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { TerminalGrid } from 'maka/host';
import type { ResourceUpdate } from '../../../../../packages/plugin-sdk/src/index.js';
import { currentLocale } from '../../../workbench/app/locale';
import { Terminal } from '../../../workbench/app/Terminal';
import type { TerminalModel } from '../../../workbench/app/terminalState';

function Preview() {
  currentLocale.set('en');
  const size = { cols: 40, rows: 12 };
  const grid = new TerminalGrid(size);
  const version = signal(0);
  const height = signal(130);
  const entry = signal<ResourceUpdate>({
    sessionId: 'terminal-output-fixture',
    ownership: { kind: 'local' },
    correlation: {},
    visibility: 'model',
    initiator: 'user',
    result: {
      kind: 'shell_run',
      ref: 'output',
      mode: 'pty',
      status: 'running',
      cwd: '/workspace',
      cmd: 'terminal output fixture',
      startedAt: 1,
      updatedAt: 1,
      revision: 1,
    },
  });
  const noop = () => {};
  const model: TerminalModel = {
    target: { sessionId: entry().sessionId, ref: entry().result.ref },
    grid,
    version,
    entry,
    state: signal('live'),
    error: () => '',
    control: signal('none'),
    stopping: signal(false),
    running: () => true,
    local: () => true,
    agentOwned: () => false,
    focusRequested: signal(false),
    controllable: () => false,
    viewport: createTerminalViewport(),
    update: noop,
    activate: noop,
    suspend: noop,
    input: noop,
    resize: noop,
    takeControl: noop,
    release: noop,
    retry: noop,
    stop: async () => {},
    dispose: noop,
  };
  const write = (text: string) => {
    const sequence = version() + 1;
    grid.apply({
      kind: 'data',
      sequence,
      initialSize: size,
      size,
      dataBase64: btoa(text),
    });
    version.set(sequence);
  };
  const colors = ['210;40;100', '20;170;230', '120;200;30', '230;130;20', '165;90;235'];
  let batch = 0;
  const append = () => {
    const color = colors[batch % colors.length];
    const label = `batch ${batch++}`;
    write(`\x1b[48;2;${color}m${label}     \x1b[0m\r\n`.repeat(14));
  };
  append();
  return (
    <View style={{ flex: 1, padding: 20, gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button accessibilityLabel={`Append batch ${version()}`} onPress={append}>
          <Text>Append batch</Text>
        </Button>
        <Button onPress={() => height.set(174)}>
          <Text>Resize viewport</Text>
        </Button>
        <Button
          onPress={() => {
            const line = '\x1b[48;2;180;100;35mCleared    \x1b[0m';
            write('\x1b[3J\x1b[2J\x1b[H' + (line + '\r\n').repeat(size.rows - 1) + line);
          }}
        >
          <Text>Clear output</Text>
        </Button>
      </View>
      <View style={{ width: 420, height: height() }}>
        <Terminal model={model} />
      </View>
    </View>
  );
}

mount(Preview);
