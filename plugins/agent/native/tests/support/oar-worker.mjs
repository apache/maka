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

import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
const commands = input[Symbol.asyncIterator]();
const read = async () => JSON.parse((await commands.next()).value);
const request = await read();
if (request.kind === 'setup') {
  const trace = connect(Number(process.argv[2]), '127.0.0.1');
  await new Promise((resolve, reject) => {
    trace.once('connect', resolve);
    trace.once('error', reject);
  });
  await new Promise((resolve) =>
    trace.end(`${JSON.stringify({ phase: 'setup', request })}\n`, resolve),
  );
  trace.destroy();
  process.stdout.write(
    `${JSON.stringify({ sequence: 1, kind: 'setup', value: { kind: 'unsupported', detail: 'Runtime has no installer' } })}\n`,
  );
  input.close();
  process.stdin.destroy();
} else if (request.kind === 'catalog') {
  process.stdout.write(
    `${JSON.stringify({
      sequence: 1,
      kind: 'catalog',
      value: [
        {
          runtime: 'codex',
          installation: { kind: 'available' },
          models: {
            kind: 'ok',
            models: Array.from({ length: 20 }, (_, i) => ({
              id: `external-${i}`,
              displayName: `External ${i}`,
              effortLevels: ['vendor-deep'],
              defaultEffort: 'vendor-deep',
            })),
          },
        },
        {
          runtime: 'antigravity',
          installation: { kind: 'available' },
          models: { kind: 'unauthenticated', detail: 'Login required' },
        },
      ],
    })}\n`,
  );
  input.close();
  process.stdin.destroy();
} else {
  const control = connect(Number(process.argv[2]), '127.0.0.1');
  await new Promise((resolve, reject) => {
    control.once('connect', resolve);
    control.once('error', reject);
  });
  const gates = createInterface({ input: control });
  const gate = gates[Symbol.asyncIterator]();
  let sequence = 0;
  const publish = (body) =>
    process.stdout.write(`${JSON.stringify({ sequence: ++sequence, ...body })}\n`);
  const observe = (phase) =>
    control.write(`${JSON.stringify({ phase, request, pid: process.pid })}\n`);
  const ack = async () => {
    const value = await read();
    if (value.kind !== 'ack' || value.sequence !== sequence)
      throw new Error('Wrong commit acknowledgement');
  };
  publish({ kind: 'opened', sessionId: request.resume ?? 'native-fixture-session' });
  await ack();
  observe('opened');
  await gate.next();
  publish({
    kind: 'event',
    event: {
      kind: 'text_delta',
      agentPath: [],
      sessionId: 'native-fixture-session',
      text: 'committed output',
    },
  });
  await ack();
  observe('output');
  if (request.message === 'wait') {
    const value = await read();
    if (value.kind !== 'cancel') throw new Error('Expected cancellation');
    publish({ kind: 'result', result: { kind: 'aborted' } });
  } else {
    await gate.next();
    if (request.message === 'crash') process.exit(3);
    publish({ kind: 'result', result: { kind: 'completed', text: 'committed output' } });
  }
  observe('terminal');
  await gate.next();
  gates.close();
  control.destroy();
  input.close();
  process.stdin.destroy();
}
