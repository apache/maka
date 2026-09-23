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
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { buildExecutorPlugins } from './build-executor-plugins.mjs';

test('dev replaces stale Host plugin entries with loadable PR2 implementations', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'maka-dev-executor-build-'));
  try {
    const runtime = join(outputRoot, 'packages/acp-executor-plugin/dist/plugin.mjs');
    const adapter = join(outputRoot, 'packages/antigravity-acp-plugin/dist/plugin.mjs');
    await mkdir(join(outputRoot, 'packages/acp-executor-plugin/dist'), { recursive: true });
    await writeFile(runtime, 'export default { stale: true };');
    // Also exercises a clean adapter build with no existing output directory.
    await buildExecutorPlugins({ outputRoot });
    const acp = await import(pathToFileURL(runtime).href);
    const antigravity = await import(pathToFileURL(adapter).href);
    const provider = new acp.AcpExecutor(antigravity.antigravityAcpAdapter, {
      executable: join(outputRoot, 'missing-agent'),
    });
    assert.equal(typeof provider.discover, 'function');
    assert.equal(typeof provider.inspectConversation, 'function');
    assert.equal(typeof provider.configureConversation, 'function');
    const catalog = await provider.discover({ cwd: outputRoot, signal: new AbortController().signal });
    assert.equal(catalog.readiness, 'unavailable');
    assert.deepEqual(catalog.models, []);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
