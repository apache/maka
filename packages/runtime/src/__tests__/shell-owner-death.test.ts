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
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// `wrapped` runs the script as the child of a shell root. Its child is outside
// the root's own libuv job on Windows, so only the supervisor's tree stop
// reaches it there.
for (const mode of ['bounded', 'pipes', 'wrapped']) {
  for (const beginStop of [false, true]) {
    if (mode === 'wrapped' && beginStop) continue;
    test(`${mode} (stop already requested: ${beginStop}): owner SIGKILL terminates an admitted command before its delayed write`, {
      // A Windows stop is an immediate forced kill, so there is no window in
      // which a stopping command still runs when its owner dies.
      skip:
        beginStop && process.platform === 'win32'
          ? 'POSIX graceful SIGTERM window required'
          : false,
      timeout: 15_000,
    }, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'maka-owner-death-'));
      const marker = join(directory, 'started.json');
      const late = join(directory, 'late.txt');
      const script = join(directory, 'writer.cjs');
      await writeFile(
        script,
        `const fs=require('node:fs');\nprocess.on('SIGTERM',()=>{});\nfs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,ppid:process.ppid}));\nsetTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'late'),1500);\nsetInterval(()=>{},1000);`,
      );
      const owner = fork(
        new URL('./fixtures/shell-owner.js', import.meta.url),
        [mode, directory, script],
        { silent: true, execArgv: [] },
      );
      let command: { pid: number; ppid: number } | undefined;
      let diagnostic = '';
      owner.stderr?.on('data', (chunk) => {
        diagnostic += String(chunk);
      });
      const exited = new Promise((resolve) => owner.once('exit', resolve));
      try {
        const deadline = Date.now() + 8_000;
        while (!command) {
          try {
            command = JSON.parse(await readFile(marker, 'utf8'));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          assert.ok(Date.now() < deadline, diagnostic || 'Command did not start');
          await delay(10);
        }
        if (beginStop) {
          owner.send('stop');
          await delay(75);
        }
        assert.equal(owner.kill('SIGKILL'), true);
        await exited;
        await delay(1800);
        await assert.rejects(
          readFile(late, 'utf8'),
          { code: 'ENOENT' },
          'Command wrote after its owner was killed',
        );
      } finally {
        owner.kill('SIGKILL');
        if (command) {
          for (const pid of [command.pid, ...(command.ppid !== owner.pid ? [command.ppid] : [])]) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* already exited */
            }
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

test('owner SIGKILL also terminates a descendant that left the command group with setsid', {
  skip: process.platform === 'win32' ? 'POSIX detached process-group semantics required' : false,
  timeout: 15_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-owner-death-setsid-'));
  const marker = join(directory, 'escaped.json');
  const late = join(directory, 'late.txt');
  const script = join(directory, 'escaper.cjs');
  const escapee = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,pgid:process.pid}));setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'late'),1500);setInterval(()=>{},1000);`;
  // The command stays alive while its child leads a new session, outside the
  // supervisor's process group but still inside its process tree.
  await writeFile(
    script,
    `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(escapee)}],{detached:true,stdio:'ignore'}).unref();\nsetInterval(()=>{},1000);`,
  );
  const owner = fork(
    new URL('./fixtures/shell-owner.js', import.meta.url),
    ['bounded', directory, script],
    {
      silent: true,
      execArgv: [],
    },
  );
  let escaped: { pid: number } | undefined;
  let diagnostic = '';
  owner.stderr?.on('data', (chunk) => {
    diagnostic += String(chunk);
  });
  const exited = new Promise((resolve) => owner.once('exit', resolve));
  try {
    const deadline = Date.now() + 8_000;
    while (!escaped) {
      try {
        escaped = JSON.parse(await readFile(marker, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      assert.ok(Date.now() < deadline, diagnostic || 'Escaped descendant did not start');
      await delay(10);
    }
    assert.equal(owner.kill('SIGKILL'), true);
    await exited;
    await delay(1800);
    await assert.rejects(
      readFile(late, 'utf8'),
      { code: 'ENOENT' },
      'An escaped descendant wrote after its owner was killed',
    );
  } finally {
    owner.kill('SIGKILL');
    if (escaped) {
      try {
        process.kill(escaped.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
