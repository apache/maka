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
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
const commands = input[Symbol.asyncIterator]();
const read = async () => JSON.parse((await commands.next()).value);
const request = await read();
if (request.kind === 'setup' || request.kind === 'catalog') {
  const trace = connect(Number(process.argv[2]), '127.0.0.1');
  await new Promise((resolve, reject) => {
    trace.once('connect', resolve);
    trace.once('error', reject);
  });
  trace.write(`${JSON.stringify({ phase: request.kind, request, pid: process.pid })}\n`);
  if (request.kind === 'catalog' && process.argv.includes('--hold-catalog')) {
    const gates = createInterface({ input: trace });
    const gate = gates[Symbol.asyncIterator]();
    const released = await Promise.race([gate.next().then(() => 'released'), read()]);
    if (released !== 'released') {
      if (released.kind !== 'cancel') throw new Error('Expected query cancellation');
      trace.write(`${JSON.stringify({ phase: 'catalog_cancelled', request })}\n`);
    }
    gates.close();
  }
  const catalogs = [
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
  ];
  const value =
    request.kind === 'setup'
      ? request.action === 'install'
        ? { kind: 'installed' }
        : { kind: 'unsupported', detail: 'Runtime has no installer' }
      : request.runtime === undefined
        ? catalogs
        : (catalogs.find((entry) => entry.runtime === request.runtime) ?? {
            kind: 'unsupported',
            detail: 'Unknown runtime',
          });
  process.stdout.write(`${JSON.stringify({ sequence: 1, kind: request.kind, value })}\n`);
  await new Promise((resolve) => trace.end(resolve));
  trace.destroy();
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
  const identityFailure =
    request.message === 'identity-failure' || request.message === 'identity-failure-crash';
  if (identityFailure) {
    observe('before_opened');
    await gate.next();
  }
  publish({ kind: 'opened', sessionId: request.resume ?? 'native-fixture-session' });
  if (identityFailure) {
    const cancellation = await read();
    if (cancellation.kind !== 'cancel')
      throw new Error('Identity failure must not acknowledge or prompt');
    control.write(
      `${JSON.stringify({ phase: 'cancelled_without_prompt', request, control: cancellation })}\n`,
    );
    if (request.message === 'identity-failure-crash') process.exit(3);
    publish({ kind: 'result', result: { kind: 'aborted' } });
    observe('terminal');
    await gate.next();
  } else {
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
      if (request.message === 'pipe-holder-crash') {
        const escaped = spawn(
          process.execPath,
          ['-e', 'setTimeout(() => process.exit(0), 30000); setInterval(() => {}, 1000)'],
          {
            detached: true,
            stdio: ['ignore', 'inherit', 'ignore'],
          },
        );
        await new Promise((resolve, reject) => {
          escaped.once('spawn', resolve);
          escaped.once('error', reject);
        });
        escaped.unref();
        await new Promise((resolve) =>
          control.write(`${JSON.stringify({ phase: 'escaped', pid: escaped.pid })}\n`, resolve),
        );
        process.exit(3);
      }
      if (request.message === 'crash') process.exit(3);
      publish({ kind: 'result', result: { kind: 'completed', text: 'committed output' } });
    }
    observe('terminal');
    await gate.next();
  }
  gates.close();
  control.destroy();
  input.close();
  process.stdin.destroy();
}
