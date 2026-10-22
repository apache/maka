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

// This entrypoint is PID 1 in the producer's private PID namespace. It is not
// imported by the Host. Exiting PID 1 makes the kernel kill and reap every
// remaining process, including descendants that changed session/process group.
import { spawn } from 'node:child_process';
function finish(exitCode: number | null): never {
  process.exit(exitCode ?? 125);
}

if (process.platform !== 'linux' || process.pid !== 1) {
  throw new Error('Dependency supervisor requires a private PID namespace');
}
const [executable, ...args] = process.argv.slice(2);
if (!executable) throw new Error('Missing producer executable');
process.stdin.once('data', () => finish(null));
process.stdin.once('end', () => finish(null));
process.stdin.resume();
const child = spawn(executable, args, { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', () => finish(null));
// Do not wait for inherited stdout handles held by a descendant. PID namespace
// teardown, not pipe closure, owns descendant lifetime.
child.once('exit', (code) => finish(code));
