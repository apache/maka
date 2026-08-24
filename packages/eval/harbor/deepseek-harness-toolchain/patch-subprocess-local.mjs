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

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('toolchain root is required');

const target = join(
  root,
  'node_modules',
  '@deepseek-ai',
  'dsh-subprocess-local',
  'lib',
  'index.js',
);

const hostExitBefore = `\
\tterminateForHostExit() {
\t\tthis.forceStopDescendants();
\t\tthis.forceStopShell();
\t\tthis.forceStopDescendants();
\t}`;
const hostExitAfter = `\
\tterminateForHostExit() {
\t\tif (process.env.DSH_PRESERVE_BACKGROUND_PROCESSES === "1") {
\t\t\tthis.forceStopShell();
\t\t\treturn;
\t\t}
\t\tthis.forceStopDescendants();
\t\tthis.forceStopShell();
\t\tthis.forceStopDescendants();
\t}`;

const closeBefore = `\
\tasync closeOnce() {
\t\tlet survivors = await this.stopDescendants();
\t\tif (survivors.length > 0) throw new Error(\`terminal cleanup failed; surviving pids: \${survivors.map((member) => member.pid).join(", ")}\`);
\t\tawait this.stopShell();
\t\tsurvivors = await this.stopDescendants();
\t\tif (survivors.length > 0) throw new Error(\`terminal cleanup failed; surviving pids: \${survivors.map((member) => member.pid).join(", ")}\`);
\t\tthis.dataDisposable.dispose();
\t\tthis.exitDisposable.dispose();
\t}`;
const closeAfter = `\
\tasync closeOnce() {
\t\tif (process.env.DSH_PRESERVE_BACKGROUND_PROCESSES === "1") {
\t\t\tawait this.stopShell();
\t\t\tthis.dataDisposable.dispose();
\t\t\tthis.exitDisposable.dispose();
\t\t\treturn;
\t\t}
\t\tlet survivors = await this.stopDescendants();
\t\tif (survivors.length > 0) throw new Error(\`terminal cleanup failed; surviving pids: \${survivors.map((member) => member.pid).join(", ")}\`);
\t\tawait this.stopShell();
\t\tsurvivors = await this.stopDescendants();
\t\tif (survivors.length > 0) throw new Error(\`terminal cleanup failed; surviving pids: \${survivors.map((member) => member.pid).join(", ")}\`);
\t\tthis.dataDisposable.dispose();
\t\tthis.exitDisposable.dispose();
\t}`;

let source = await readFile(target, 'utf8');
source = replaceExactlyOnce(source, hostExitBefore, hostExitAfter, 'host-exit cleanup');
source = replaceExactlyOnce(source, closeBefore, closeAfter, 'terminal cleanup');
await writeFile(target, source, 'utf8');

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`DeepSeek Harness ${label} patch target drifted`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}
