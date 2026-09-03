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

// Protocol-only regressions for the private Windows helper. These never
// launch a fixture or interact with a desktop window.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const helperExe = process.argv[2];
if (!helperExe) {
  console.error('usage: node protocol-regression.mjs <helper-exe>');
  process.exit(2);
}

const waitExit = (child, timeoutMs) =>
  new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      finish({ code, signal, timeout: false });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      finish({ code: null, signal: null, timeout: false, error: error.code ?? error.message });
    });
    timer = setTimeout(() => finish({ code: null, signal: null, timeout: true }), timeoutMs);
  });
const send = (child, value) => child.stdin.write(JSON.stringify(value) + '\n');
const ensureStopped = async (child) => {
  if (child.exitCode !== null) return;
  child.kill();
  await waitExit(child, 1000);
};

async function malformedMethod() {
  const child = spawn(helperExe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const rl = createInterface({ input: child.stdout });
  const messages = [];
  rl.on('line', (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {}
  });
  send(child, { jsonrpc: '2.0', id: 1, method: 7 });
  const responseDeadline = Date.now() + 2000;
  while (Date.now() < responseDeadline && !messages.some((m) => m.id === 1))
    await new Promise((r) => setTimeout(r, 20));
  child.stdin.end();
  const exit = await waitExit(child, 4000);
  const pass = messages.some((m) => m.id === 1 && m.error?.code === -32600) && exit.code === 0;
  console.log(
    `${pass ? 'PASS' : 'FAIL'} malformed method is typed and helper exits`,
    JSON.stringify({ messages, exit }),
  );
  await ensureStopped(child);
  return pass;
}

async function unknownCancel() {
  const child = spawn(helperExe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const rl = createInterface({ input: child.stdout });
  const messages = [];
  rl.on('line', (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {}
  });
  send(child, { jsonrpc: '2.0', id: 1, method: 'debug_sleep', params: { ms: 300 } });
  send(child, { jsonrpc: '2.0', id: 2, method: 'debug_sleep', params: { ms: 20 } });
  send(child, { jsonrpc: '2.0', method: '$/cancel', params: { id: 999 } });
  send(child, { jsonrpc: '2.0', method: '$/cancel', params: [] });
  const until = Date.now() + 3000;
  while (
    Date.now() < until &&
    (!messages.some((m) => m.id === 1) || !messages.some((m) => m.id === 2))
  )
    await new Promise((r) => setTimeout(r, 20));
  child.stdin.end();
  const exit = await waitExit(child, 4000);
  const pass =
    messages.some((m) => m.id === 1 && m.result?.sleptMs === 300) &&
    messages.some((m) => m.id === 2 && m.result?.sleptMs === 20) &&
    !messages.some((m) => m.id === null) &&
    exit.code === 0;
  console.log(
    `${pass ? 'PASS' : 'FAIL'} unknown cancel does not affect unrelated requests`,
    JSON.stringify({ messages, exit }),
  );
  await ensureStopped(child);
  return pass;
}

async function eofBackpressure() {
  // Intentionally never attach a stdout reader. The bounded helper writer
  // must fail closed and exit instead of becoming an orphan behind a pipe.
  const child = spawn(helperExe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  for (let i = 0; i < 1000; i++)
    send(child, { jsonrpc: '2.0', id: i + 1, method: 'initialize', params: {} });
  child.stdin.end();
  const exit = await waitExit(child, 5000);
  const pass = exit.code === 0 || exit.code === 2;
  console.log(
    `${pass ? 'PASS' : 'FAIL'} EOF plus stdout backpressure exits bounded`,
    JSON.stringify(exit),
  );
  if (exit.timeout) child.kill();
  return pass;
}

const results = [await malformedMethod(), await unknownCancel(), await eofBackpressure()];
console.log(`protocol failures=${results.filter((x) => !x).length}`);
process.exitCode = results.every(Boolean) ? 0 : 1;
