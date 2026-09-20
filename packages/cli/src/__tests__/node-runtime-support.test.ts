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
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  isSupportedNodeRuntimeVersion,
  nodeRuntimeRefusal,
  probeNodeRuntime,
  SUPPORTED_NODE_RUNTIME_RANGE,
} from '../node-runtime-support.js';

test('the supported range excludes Node releases without the zstd bindings', () => {
  for (const version of ['22.19.0', '22.20.4', '23.8.0', '23.11.1', '24.0.0', 'v24.18.1']) {
    assert.equal(isSupportedNodeRuntimeVersion(version), true, version);
  }
  for (const version of ['22.14.0', '22.18.9', '23.0.0', '23.7.0', 'v23.7.9', '20.18.0']) {
    assert.equal(isSupportedNodeRuntimeVersion(version), false, version);
  }
});

test('the running runtime satisfies the range the repository declares', () => {
  assert.equal(isSupportedNodeRuntimeVersion(process.versions.node), true);
  assert.equal(SUPPORTED_NODE_RUNTIME_RANGE, '>=22.19.0 <23.0.0 || >=23.8.0');
});

test('an unsupported version is named together with the binary it was read from', () => {
  const refusal = nodeRuntimeRefusal(
    { kind: 'version', version: '23.7.0' },
    '/opt/node-23.7.0/bin/node',
  );
  assert.equal(refusal?.kind, 'unusable');
  assert.match(refusal?.message ?? '', /23\.7\.0/u);
  assert.match(refusal?.message ?? '', /\/opt\/node-23\.7\.0\/bin\/node/u);
  assert.match(refusal?.message ?? '', />=22\.19\.0 <23\.0\.0 \|\| >=23\.8\.0/u);
  assert.equal(nodeRuntimeRefusal({ kind: 'version', version: process.versions.node }), undefined);
});

test('a runtime that cannot be executed is unusable', () => {
  const refusal = nodeRuntimeRefusal(
    { kind: 'unusable', detail: 'the pinned binary does not exist' },
    '/opt/maka/node',
  );
  assert.equal(refusal?.kind, 'unusable');
  assert.match(refusal?.message ?? '', /\/opt\/maka\/node/u);
  assert.match(refusal?.message ?? '', /does not exist/u);
});

test('a runtime nothing could verify is refused as unverified, not as a verdict', () => {
  const refusal = nodeRuntimeRefusal(
    { kind: 'unknown', detail: 'the runtime did not answer before the probe deadline' },
    '/opt/slow/node',
  );
  assert.equal(refusal?.kind, 'unverified');
  assert.match(refusal?.message ?? '', /could not verify/u);
  assert.match(refusal?.message ?? '', /Retry/u);
  // The remedy is a retry, never a reinstall: this says nothing about the version.
  assert.doesNotMatch(refusal?.message ?? '', />=22\.19\.0/u);
});

test('probing this process reports its own version without launching it', async () => {
  assert.deepEqual(await probeNodeRuntime(process.execPath), {
    kind: 'version',
    version: process.versions.node,
  });
});

test('each way a pinned binary can fail is classified as unusable', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-node-runtime-probe-'));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const absent = await probeNodeRuntime(join(base, 'absent'));
  assert.equal(absent.kind, 'unusable');
  assert.match(absent.kind === 'unusable' ? absent.detail : '', /does not exist/u);

  const notExecutable = join(base, 'not-executable');
  await writeFile(notExecutable, 'not a runtime\n');
  await chmod(notExecutable, 0o644);
  assert.equal((await probeNodeRuntime(notExecutable)).kind, 'unusable');

  if (process.platform !== 'win32') {
    const failing = join(base, 'failing');
    await writeFile(failing, '#!/bin/sh\nexit 3\n');
    await chmod(failing, 0o755);
    assert.equal((await probeNodeRuntime(failing)).kind, 'unusable');

    const chatty = join(base, 'chatty');
    await writeFile(chatty, '#!/bin/sh\necho not-a-version\n');
    await chmod(chatty, 0o755);
    const malformed = await probeNodeRuntime(chatty);
    assert.equal(malformed.kind, 'unusable');
    assert.match(malformed.kind === 'unusable' ? malformed.detail : '', /did not report/u);

    const supported = join(base, 'supported');
    await writeFile(supported, '#!/bin/sh\necho 24.21.0\n');
    await chmod(supported, 0o755);
    assert.deepEqual(await probeNodeRuntime(supported), {
      kind: 'version',
      version: '24.21.0',
    });
  }
});

test('a timed out probe is retried before the runtime is left unverified', async (t) => {
  if (process.platform !== 'win32') {
    const base = await mkdtemp(join(tmpdir(), 'maka-node-runtime-timeout-'));
    t.after(async () => {
      await rm(base, { recursive: true, force: true });
    });

    const stalling = join(base, 'stalling');
    await writeFile(stalling, '#!/bin/sh\nsleep 3\necho 24.21.0\n');
    await chmod(stalling, 0o755);
    const unanswered = await probeNodeRuntime(stalling, { timeoutMs: 400, attempts: 2 });
    assert.equal(unanswered.kind, 'unknown');
    assert.equal(nodeRuntimeRefusal(unanswered, stalling)?.kind, 'unverified');

    // A runtime that is merely slow to start once still answers on the retry, so a
    // single stalled spawn never decides the deployment.
    const counter = join(base, 'slow-once-count');
    const slowOnce = join(base, 'slow-once');
    await writeFile(
      slowOnce,
      `#!/bin/sh\ncount=$(cat ${counter} 2>/dev/null || echo 0)\ncount=$((count+1))\necho $count > ${counter}\nif [ "$count" -lt 2 ]; then sleep 3; fi\necho 24.21.0\n`,
    );
    await chmod(slowOnce, 0o755);
    assert.deepEqual(await probeNodeRuntime(slowOnce, { timeoutMs: 1_500, attempts: 2 }), {
      kind: 'version',
      version: '24.21.0',
    });
    assert.equal((await readFile(counter, 'utf8')).trim(), '2');
  }
});
