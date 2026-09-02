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

// Short lived host for PD. The fixture is frozen by lifecycle-driver before
// this probe starts, so observe is a real blocked UIA provider operation.
// The probe proves initialize and observe dispatch, then exits without
// touching the helper PID. stdin/stdout close with the host process.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const helperExe = process.argv[2];
const hwnd = Number(process.argv[3]);
if (!helperExe || !Number.isInteger(hwnd) || hwnd <= 0) process.exit(2);

const helper = spawn(helperExe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
console.log(`HELPER ${helper.pid}`);
const rl = createInterface({ input: helper.stdout });
let initialized = false;
let observeSent = false;
let observeSettled = false;
let stageTimer;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === 1 && msg.result) {
    initialized = true;
    console.log('HOST_STAGE initialized');
    helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'observe', params: { hwnd } }) + '\n');
    observeSent = true;
    console.log('HOST_STAGE observe_sent');
    // Give the actual blocked provider call a bounded interval. Startup has
    // a separate generous deadline for cold single-file extraction.
    stageTimer = setTimeout(() => {
      if (observeSettled) process.exit(3);
      process.exit(77);
    }, 700);
  } else if (msg.id === 2) {
    observeSettled = true;
    console.log('HOST_STAGE observe_settled');
  }
});
helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
setTimeout(() => {
  // A blocked provider must still be unresolved when its parent disappears.
  if (!initialized || !observeSent) process.exit(3);
}, 10000);
