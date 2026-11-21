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

import { cleanup, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { Terminal } from '../../../workbench/app/Terminal';
import { createTerminalPresentation } from '../../../workbench/app/terminalState';
import { currentLocale } from '../../../workbench/app/locale';

function Preview() {
  currentLocale.set('en');
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected transport call');
  };
  const model = createTerminalPresentation(
    {
      ownership: { kind: 'local' },
      visibility: 'model',
      initiator: 'agent',
      result: {
        kind: 'shell_run',
        ref: 'viewport',
        mode: 'pty',
        status: 'running',
        cwd: '/workspace',
        cmd: 'viewport fixture',
        startedAt: 1,
        updatedAt: 1,
        revision: 1,
      },
    },
    {
      readDisplay: unused,
      watch: unused,
      watchOutput: unused,
      acquire: unused,
      control: unused,
      release: unused,
      stop: unused,
    },
    { admitted: () => true, removed: () => {} },
  );
  const height = signal(400);
  model.state.set('live');
  cleanup(() => model.dispose());
  let sequence = 0;
  const write = (text: string) => {
    model.grid.apply({
      kind: 'data',
      sequence: ++sequence,
      initialSize: { cols: 80, rows: 24 },
      size: { cols: 80, rows: 24 },
      dataBase64: btoa(text),
    });
    model.version.set(sequence);
  };
  write('READY: original first line\r\n');
  return (
    <View style={{ flex: 1, padding: 20, gap: 12, backgroundColor: '#202124' }}>
      <Text style={{ color: '#ffffff' }}>
        Original PTY: 80 x 24. Observer uses a shorter viewport.
      </Text>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Button accessibilityLabel="Short viewport" onPress={() => height.set(240)}>
          <Text>Short viewport</Text>
        </Button>
        <Button
          accessibilityLabel="Write output"
          onPress={() => write(Array.from({ length: 40 }, (_, i) => `line-${i}\r\n`).join(''))}
        >
          <Text>Write output</Text>
        </Button>
        <Button
          accessibilityLabel="Clear output"
          onPress={() => write('\x1b[2J\x1b[HAFTER CLEAR\r\n')}
        >
          <Text>Clear output</Text>
        </Button>
      </View>
      <View style={{ height: height() }}>
        <Terminal model={model} />
      </View>
    </View>
  );
}
mount(Preview);
