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
import test from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { antigravityRuntime } from '@botiverse/oar/runtimes/antigravity';
import { bundleWorker } from './build.mjs';

async function fixture(t, legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), 'maka-agy-patch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = legacy ? 'agy_acp_server.par' : 'agy';
  const command = join(directory, process.platform === 'win32' ? `${name}.cmd` : name);
  const script = fileURLToPath(new URL('./fixtures/antigravity.mjs', import.meta.url));
  await writeFile(
    command,
    process.platform === 'win32'
      ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
  );
  await chmod(command, 0o755);
  const env = {
    ...process.env,
    OAR_ANTIGRAVITY_BIN: command,
    MAKA_AGY_TRACE: join(directory, 'trace.jsonl'),
    MAKA_AGY_SESSION: join(directory, 'session.json'),
    MAKA_AGY_LEGACY: legacy ? '1' : '',
  };
  return { directory, command, env };
}

async function worker(entry, request, f) {
  const child = spawn(process.execPath, [entry], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  const packets = [];
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const reading = (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      const packet = JSON.parse(line);
      packets.push(packet);
      if (packet.kind === 'opened' || packet.kind === 'event')
        child.stdin.write(`${JSON.stringify({ kind: 'ack', sequence: packet.sequence })}\n`);
    }
  })();
  try {
    child.stdin.write(
      `${JSON.stringify({ runtime: 'antigravity', cwd: f.directory, ...request })}\n`,
    );
    assert.equal(await closed, 0, stderr);
    await reading;
    return packets;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

test('the pinned patch discovers the official default CLI layout without falling back from an override', {
  skip: process.platform === 'win32',
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t);
  const bin = join(f.directory, '.local', 'bin');
  await mkdir(bin, { recursive: true });
  const command = join(bin, 'agy');
  await writeFile(command, await readFile(f.command));
  await chmod(command, 0o755);
  const env = { ...f.env, HOME: f.directory, PATH: '', OAR_ANTIGRAVITY_BIN: null };
  assert.deepEqual(await antigravityRuntime.installation({ env }), {
    kind: 'available',
    via: 'executable',
    command,
    version: '1.5.0',
  });
  assert.deepEqual(
    await antigravityRuntime.installation({
      env: { ...env, OAR_ANTIGRAVITY_BIN: join(f.directory, 'missing') },
    }),
    { kind: 'not_found' },
  );
});

test('the product bundle uses patched CLI discovery, native model/effort, execution, resume and legacy argv', {
  timeout: 30000,
}, async (t) => {
  const output = await fixture(t);
  const entry = await bundleWorker(join(output.directory, 'bundle'));
  for (const legacy of [false, true]) {
    const f = await fixture(t, legacy);
    const catalog = await worker(entry, { kind: 'catalog' }, f);
    assert.deepEqual(catalog[0].value, {
      runtime: 'antigravity',
      installation: {
        kind: 'available',
        via: 'executable',
        command: f.command,
        version: legacy ? '1.4.5' : '1.5.0',
      },
      models: {
        kind: 'ok',
        models: [
          {
            id: 'gemini-fixture',
            displayName: 'Gemini Fixture',
            default: true,
            effortLevels: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
        ],
      },
    });
    for (const resume of [undefined, 'fixture-agy']) {
      const packets = await worker(
        entry,
        { kind: 'execute', model: 'gemini-fixture', effort: 'low', message: 'hello', resume },
        f,
      );
      assert.equal(packets.find((packet) => packet.kind === 'opened').sessionId, 'fixture-agy');
      assert.deepEqual(packets.at(-1).result, {
        kind: 'completed',
        text: 'native:gemini-fixture:low:hello',
      });
    }
    const trace = (await readFile(f.env.MAKA_AGY_TRACE, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(trace.filter((item) => item.method === 'session/resume').length, 1);
    assert.equal(
      trace.some((item) => item.method === 'authenticate'),
      false,
    );
    const native = trace.filter((item) => item.argv && item.argv[0] !== '--version');
    assert.equal(native.length, 3);
    for (const item of native)
      assert.deepEqual(
        item.argv,
        legacy ? (process.platform === 'linux' ? ['--uid='] : []) : ['acp'],
      );
  }
});

test('Antigravity plans the documented native CLI installer instead of a GUI-only unsupported result', async () => {
  const result = await antigravityRuntime.installPlan();
  if (process.platform === 'win32') {
    assert.equal(result.kind, 'unsupported');
    assert.equal(result.reason, 'platform');
    return;
  }
  assert.equal(result.kind, 'plan');
  assert.equal(result.source, 'https://antigravity.google/docs/getting-started/?tab=cli');
  assert.deepEqual(
    result.steps.map((step) => step.display),
    ['curl -fsSL https://antigravity.google/cli/install.sh | bash'],
  );
});
