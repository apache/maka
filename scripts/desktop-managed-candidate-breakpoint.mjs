// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements. See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';

/** Pause real product code after candidate verification, before SQLite acceptance. */
export async function armCandidateBreakpoint(root, repo, terminal = 'successor') {
  assert.ok(['successor', 'no_change', 'failure'].includes(terminal));
  let endpoint;
  await expect
    .poll(
      async () => {
        try {
          endpoint = JSON.parse(await readFile(join(root, 'host-debugger.json'), 'utf8'));
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
        return Boolean(endpoint?.endpoint);
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const url = new URL(endpoint.endpoint);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.protocol, 'ws:');
  assert.ok(Number.isSafeInteger(endpoint.pid) && endpoint.pid > 0);
  const socket = new WebSocket(url);
  let nextId = 0;
  let paused;
  const pending = new Map();
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Host debugger disconnected'));
    }
    pending.clear();
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Debugger.paused') paused = message.params;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Debugger timeout: ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Debugger connection timeout')), 10000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('Debugger connection failed'));
        },
        { once: true },
      );
    });
    await send('Debugger.enable');
    const file = join(
      repo,
      'packages/runtime-host/dist/server/gitoxide-workspace-baseline-owner-internal.js',
    );
    const lines = (await readFile(file, 'utf8')).split('\n');
    const functionName =
      terminal === 'failure'
        ? 'acceptRejectedOperation'
        : terminal === 'no_change'
          ? 'acceptUnchangedCandidate'
          : 'acceptPublishedCandidate';
    const methodStart = lines.findIndex((line) => line.includes(`async ${functionName}(input)`));
    assert.ok(methodStart >= 0, 'Expected candidate owner method');
    const methodEnd = lines.findIndex((line, index) => index > methodStart && line.trim() === '},');
    assert.ok(methodEnd > methodStart, 'Expected candidate owner method end');
    const statement =
      terminal !== 'successor'
        ? 'return verified.authority.commitNoEffect({'
        : 'return verified.authority.commitSuccessor({';
    const matches = lines.flatMap((line, index) =>
      index > methodStart && index < methodEnd && line.includes(statement) ? [index] : [],
    );
    assert.equal(matches.length, 1, 'Rebuild/review the breakpoint if production code changes');
    const breakpoint = await send('Debugger.setBreakpointByUrl', {
      url: pathToFileURL(file).href,
      lineNumber: matches[0],
    });
    return {
      pid: endpoint.pid,
      async wait() {
        await expect.poll(() => Boolean(paused), { timeout: 30000 }).toBe(true);
        assert.ok(paused.hitBreakpoints.includes(breakpoint.breakpointId));
        assert.equal(paused.callFrames[0].functionName, functionName);
        return {
          functionName: paused.callFrames[0].functionName,
          lineNumber: paused.callFrames[0].location.lineNumber,
        };
      },
      close() {
        socket.close();
      },
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}
