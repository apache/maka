#!/usr/bin/env node
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
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MakaCompositionLoader } from '@maka/runtime/plugin-composition-loader';
import { Context } from '@maka/runtime/plugin-kernel';
import { PluginToolService } from '@maka/runtime/plugin-tool-service';
import { HostPluginPlatform } from '@maka/runtime-host/server';

const packageRoot = dirname(fileURLToPath(import.meta.url));

export async function withArrowTool(run) {
  const controlRoot = await mkdtemp(join(tmpdir(), 'maka-arrow-plugin-e2e-'));
  const installRoot = await mkdtemp(join(controlRoot, 'package-'));
  const pluginRoot = new Context();
  const tools = new PluginToolService(pluginRoot);
  const composition = new MakaCompositionLoader({ root: pluginRoot });
  const platform = new HostPluginPlatform(join(controlRoot, 'control'), {
    composition,
    tools,
  });
  try {
    await cp(join(packageRoot, 'maka.extension.json'), join(installRoot, 'maka.extension.json'));
    await cp(join(packageRoot, 'maka.composition.yml'), join(installRoot, 'maka.composition.yml'));
    await cp(join(packageRoot, 'dist'), join(installRoot, 'dist'), {
      recursive: true,
    });
    await platform.recover();
    const installed = await platform.installPackage(installRoot);
    assert.equal(installed.extensionId, 'arrow-data-analysis');
    assert.equal(installed.convergence, 'converged');
    const arrowTool = tools
      .resolve('arrow-e2e-session', [])
      .tools.find(({ name }) => name === 'arrow_analyze');
    assert.ok(arrowTool, 'Arrow tool should be registered after package activation');
    return await run(arrowTool);
  } finally {
    await platform.uninstallPackage('arrow-data-analysis').catch(() => undefined);
    await platform.close();
    await rm(controlRoot, { recursive: true, force: true });
  }
}

export async function invokeArrowTool(tool, input) {
  return await tool.impl(input, {
    abortSignal: new AbortController().signal,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await withArrowTool(async (tool) => {
    const summary = await invokeArrowTool(tool, {
      operation: 'summary',
      column: 'revenue',
      columns: { revenue: [120, 80, null, 200] },
    });
    assert.deepEqual(summary, {
      ok: true,
      operation: 'summary',
      column: 'revenue',
      rows: 4,
      valid: 3,
      nulls: 1,
      sum: 400,
      mean: 400 / 3,
      min: 80,
      max: 200,
    });

    const grouped = await invokeArrowTool(tool, {
      operation: 'group_sum',
      column: 'revenue',
      by: 'region',
      columns: {
        revenue: [120, 80, null, 200],
        region: ['east', 'west', 'east', 'west'],
      },
    });
    assert.deepEqual(grouped, {
      ok: true,
      operation: 'group_sum',
      column: 'revenue',
      by: 'region',
      groups: {
        east: { sum: 120, mean: 120, rows: 2, valid: 1, nulls: 1 },
        west: { sum: 280, mean: 140, rows: 2, valid: 2, nulls: 0 },
      },
    });

    const after = tool;
    assert.equal(after.name, 'arrow_analyze');
    console.log(JSON.stringify({ summary, grouped }, null, 2));
  });
}
