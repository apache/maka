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

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { assertElfArchitecture, verifyLinuxRelease } from './verify-linux.mjs';

// The two `e_machine` values this project ships, from the ELF specification.
const EM_X86_64 = 0x3e;
const EM_AARCH64 = 0xb7;

let workingDirectory;

before(async () => {
  workingDirectory = await mkdtemp(join(tmpdir(), 'maka-linux-harness-'));
});

after(async () => {
  await rm(workingDirectory, { recursive: true, force: true });
});

/**
 * A 64-byte ELF header is enough: the architecture assertion reads the magic,
 * `EI_DATA` and `e_machine`, and nothing else. Building the bytes here rather
 * than checking in a binary keeps the test readable and runs it on any host —
 * which is the point, since the packaging it guards only runs on Linux.
 */
async function writeElf(name, machine, { data = 1, magic = '\x7fELF' } = {}) {
  const header = Buffer.alloc(64);
  header.write(magic, 0, 'latin1');
  header[4] = 2; // EI_CLASS: ELFCLASS64
  header[5] = data; // EI_DATA: 1 little-endian, 2 big-endian
  header[6] = 1; // EI_VERSION
  header.writeUInt16LE(2, 16); // e_type: ET_EXEC
  if (data === 1) header.writeUInt16LE(machine, 18);
  else header.writeUInt16BE(machine, 18);
  const path = join(workingDirectory, name);
  await writeFile(path, header);
  return path;
}

test('the architecture assertion accepts a binary built for the target', async () => {
  await assertElfArchitecture(await writeElf('x64.node', EM_X86_64), 'x64');
  await assertElfArchitecture(await writeElf('arm64.node', EM_AARCH64), 'arm64');
});

test('the architecture assertion rejects the other architecture', async () => {
  // The failure this exists for: a runner that cross-built the Runtime Host
  // peer produces a package that installs and then dies at launch.
  const path = await writeElf('wrong.node', EM_X86_64);
  await assert.rejects(
    () => assertElfArchitecture(path, 'arm64'),
    /is built for ELF machine 0x3e, not arm64/u,
  );
});

test('the architecture assertion rejects a file that is not ELF', async () => {
  const path = join(workingDirectory, 'not-elf.node');
  await writeFile(path, 'this is not a binary at all, it is text\n');
  await assert.rejects(() => assertElfArchitecture(path, 'x64'), /is not an ELF binary/u);
});

test('the architecture assertion rejects a truncated header', async () => {
  const path = join(workingDirectory, 'truncated.node');
  await writeFile(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await assert.rejects(() => assertElfArchitecture(path, 'x64'), /is not an ELF binary/u);
});

test('the architecture assertion refuses to read a big-endian header', async () => {
  // Reading `e_machine` little-endian out of a big-endian file compares
  // garbage, so the mismatch has to be named rather than guessed at.
  const path = await writeElf('big-endian.node', EM_X86_64, { data: 2 });
  await assert.rejects(
    () => assertElfArchitecture(path, 'x64'),
    /is not a little-endian ELF binary/u,
  );
});

test('Linux verification refuses to run anywhere else', async () => {
  // The distributables only exist on the runner that built them, so running
  // this elsewhere would otherwise fail later and less clearly.
  await assert.rejects(() => verifyLinuxRelease('x64', { platform: 'darwin' }), /requires Linux/u);
});
