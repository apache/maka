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

// Focused WGC probe. Starts only the purpose-built fixture and helper, asks
// for one target-window capture, and always tears both down.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const helper = process.argv[2];
const fixture = process.argv[3];
if (!helper || !fixture) throw new Error('usage: node capture-probe.mjs <helper> <fixture>');

const fx = spawn(fixture, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const fr = createInterface({ input: fx.stdout });
let target;
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('fixture READY timeout')), 8000);
  fr.on('line', (line) => {
    const m = line.match(/^READY (\d+) (\d+)$/);
    if (m) { clearTimeout(timer); target = { pid: Number(m[1]), hwnd: Number(m[2]) }; resolve(); }
  });
});

const h = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
h.stderr.on('data', (chunk) => process.stderr.write(chunk));
const hr = createInterface({ input: h.stdout });
let nextId = 1;
const pending = new Map();
hr.on('line', (line) => {
  const msg = JSON.parse(line);
  const p = pending.get(msg.id);
  if (p) { pending.delete(msg.id); p(msg); }
});
const call = (method, params = {}, timeout = 10000) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  h.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timeout`)); }, timeout);
});

try {
  await ready;
  const hello = await call('initialize');
  const capture = await call('capture', { hwnd: target.hwnd, windowGeneration: (await call('observe', { hwnd: target.hwnd })).result.target.windowGeneration }, 10000);
  console.log(JSON.stringify({ target, hello: hello.result, capture }, null, 2));
} finally {
  try { h.stdin.end(); } catch {}
  try { fx.stdin.write('shutdown\n'); fx.stdin.end(); } catch {}
  setTimeout(() => { if (!h.killed) h.kill(); if (!fx.killed) fx.kill(); }, 300);
}
