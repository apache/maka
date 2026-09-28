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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runAntigravitySetup, createAntigravityStderrHandler } from '../server/acp/antigravity.js';
import { AcpSetupError, withAcpConnection } from '../server/acp/connection.js';

async function fixture(scenario: string, run: (executable: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'maka-acp-test-'));
  const executable = join(root, 'agent.mjs');
  const sdk = import.meta.resolve('@agentclientprotocol/sdk');
  const source = `#!${process.execPath}
import {agent,methods,ndJsonStream,RequestError} from ${JSON.stringify(sdk)};
import {Readable,Writable} from 'node:stream';
import {appendFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const scenario=${JSON.stringify(scenario)};
writeFileSync(${JSON.stringify(join(root, 'pid'))}, String(process.pid));
process.stderr.write('fixture-ready\\n');
const log=method=>appendFileSync(${JSON.stringify(join(root, 'calls'))},method+'\\n');
const app=agent({name:'fixture'}).onRequest(methods.agent.initialize,({params})=>{
 log('initialize');
 if(params.clientCapabilities.terminal || params.clientCapabilities.fs.readTextFile || params.clientCapabilities.fs.writeTextFile) throw Error('unconsumed capability');
 if(scenario==='crash') process.exit(9);
 if(scenario==='hang') return new Promise(()=>{});
 if(scenario==='helper') {
  process.on('SIGTERM',()=>{});
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
  writeFileSync(${JSON.stringify(join(root, 'helper-pid'))},String(child.pid));
 }
 return {protocolVersion:1,agentCapabilities:{},authMethods:scenario==='no-auth'?[]:[{id:'oauth-personal',name:'Google'}]};
}).onRequest(methods.agent.authenticate,async()=>{
 log('authenticate');
 if(scenario==='reject') throw Error('private credential must not appear');
 if(scenario==='ineligible') throw new RequestError(-32000, 'Onboarding failed: User is ineligible for free-tier. Reason: private account detail');
 const link='Open the following link to authenticate the ACP server: https://accounts.google.com/test?state=fixture\\n';
 process.stderr.write(link.slice(0,23));await new Promise(r=>setTimeout(r,10));process.stderr.write(link.slice(23));
 if(scenario==='login') return {};
 return new Promise(()=>{});
});
app.connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
`;
  await writeFile(executable, source, { mode: 0o700 });
  await writeFile(join(root, 'localharness_external'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  try {
    await run(executable, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const check = (executable: string) =>
  runAntigravitySetup({
    executable,
    action: 'check',
    signal: new AbortController().signal,
    onAuthorizationUrl: async () => assert.fail('check must not open browser'),
  });
async function assertStopped(root: string) {
  const pid = Number(await readFile(join(root, 'pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('check uses official SDK initialization only and releases the process', () =>
  fixture('check', async (executable, root) => {
    await check(executable);
    assert.equal(await readFile(join(root, 'calls'), 'utf8'), 'initialize\n');
    await assertStopped(root);
  }));
test('login consumes a split stderr URL and waits for authenticate completion', () =>
  fixture('login', async (executable, root) => {
    const urls: string[] = [];
    await runAntigravitySetup({
      executable,
      action: 'login',
      signal: new AbortController().signal,
      onAuthorizationUrl: async (url) => {
        urls.push(url);
        await delay(20);
      },
    });
    assert.deepEqual(urls, ['https://accounts.google.com/test?state=fixture']);
    assert.equal(await readFile(join(root, 'calls'), 'utf8'), 'initialize\nauthenticate\n');
    await assertStopped(root);
  }));
test('cancel while waiting for Google auth releases the child', () =>
  fixture('wait', async (executable, root) => {
    const abort = new AbortController();
    await assert.rejects(
      runAntigravitySetup({
        executable,
        action: 'login',
        signal: abort.signal,
        onAuthorizationUrl: async () => {
          abort.abort();
        },
      }),
      { name: 'AbortError' },
    );
    await assertStopped(root);
  }));
test('browser failure and agent rejection expose public failure codes only', async () => {
  await fixture('wait', async (executable, root) => {
    await assert.rejects(
      runAntigravitySetup({
        executable,
        action: 'login',
        signal: new AbortController().signal,
        onAuthorizationUrl: async () => {
          throw new Error('private browser diagnostic');
        },
      }),
      { failure: 'browser_failed' },
    );
    await assertStopped(root);
  });
  await fixture('reject', async (executable, root) => {
    await assert.rejects(
      runAntigravitySetup({
        executable,
        action: 'login',
        signal: new AbortController().signal,
        onAuthorizationUrl: async () => {},
      }),
      { message: 'ACP setup: authentication_failed' },
    );
    await assertStopped(root);
  });
});
test('missing helper, missing executable and unsupported auth are actionable', async () => {
  await assert.rejects(check('/missing/maka-acp-file'), { failure: 'executable_unavailable' });
  await fixture('check', async (executable, root) => {
    await rm(join(root, 'localharness_external'));
    await assert.rejects(check(executable), { failure: 'helper_unavailable' });
  });
  await fixture('no-auth', async (executable, root) => {
    await assert.rejects(
      runAntigravitySetup({
        executable,
        action: 'login',
        signal: new AbortController().signal,
        onAuthorizationUrl: async () => {},
      }),
      { failure: 'authentication_unavailable' },
    );
    await assertStopped(root);
  });
});
test('crash and timeout never report success', async () => {
  await fixture('crash', async (executable, root) => {
    await assert.rejects(check(executable), { failure: 'connection_failed' });
    await assertStopped(root);
  });
  await fixture('hang', async (executable, root) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new AcpSetupError('timed_out')), 3000);
    try {
      await assert.rejects(
        withAcpConnection(
          {
            executable,
            cwd: root,
            env: process.env,
            signal: abort.signal,
            onStderr: () => {
              abort.abort(new AcpSetupError('timed_out'));
            },
          },
          async () => new Promise(() => {}),
        ),
        { failure: 'timed_out' },
      );
      await assertStopped(root);
    } finally {
      clearTimeout(timer);
    }
  });
});
test('cleanup escalates for a server and helper ignoring SIGTERM', () =>
  fixture('helper', async (executable, root) => {
    await check(executable);
    await assertStopped(root);
    const pid = Number(await readFile(join(root, 'helper-pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }));
test('stderr handler ignores diagnostics, preserves split UTF-8, and rejects unsafe links', () => {
  const urls: string[] = [];
  const consume = createAntigravityStderrHandler((url) => urls.push(url));
  const bytes = Buffer.from(
    '诊断\nOpen the following link to authenticate the ACP server: https://accounts.google.com/login\r\n',
  );
  for (const byte of bytes) consume(Buffer.from([byte]));
  assert.deepEqual(urls, ['https://accounts.google.com/login']);
  assert.throws(
    () =>
      consume(
        Buffer.from('Open the following link to authenticate the ACP server: file:///private\n'),
      ),
    { failure: 'authentication_failed' },
  );
  assert.throws(() => consume(Buffer.alloc(32769, 65)), { failure: 'connection_failed' });
});

test('official account eligibility rejection has an actionable sanitized result', () =>
  fixture('ineligible', async (executable, root) => {
    await assert.rejects(
      runAntigravitySetup({
        executable,
        action: 'login',
        signal: new AbortController().signal,
        onAuthorizationUrl: async () => {},
      }),
      { message: 'ACP setup: account_ineligible' },
    );
    await assertStopped(root);
  }));
