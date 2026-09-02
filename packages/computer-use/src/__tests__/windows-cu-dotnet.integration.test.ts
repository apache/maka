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
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWindowsCuBackend } from '../windows-cu-backend.js';

test('Windows backend can speak to a real published helper', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only integration');
    return;
  }
  const helper = process.env.MAKA_CU_WINDOWS_HELPER;
  if (!helper) {
    t.skip('Set MAKA_CU_WINDOWS_HELPER to a published maka-cu-windows.exe');
    return;
  }
  const expectedBinarySha256 = createHash('sha256')
    .update(await readFile(helper))
    .digest('hex');
  const backend = createWindowsCuBackend({ binaryPath: helper, expectedBinarySha256 });
  const permissions = await backend.preflight(new AbortController().signal);
  assert.deepEqual(permissions, { accessibility: true, screenRecording: true });
  const apps = await backend.listApps!(new AbortController().signal);
  assert.ok(Array.isArray(apps));
  (backend as { dispose?: () => void }).dispose?.();
});

test('Windows backend drives the published helper against the WinForms fixture', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only integration');
    return;
  }
  const helper = process.env.MAKA_CU_WINDOWS_HELPER;
  const fixture = process.env.MAKA_CU_WINDOWS_FIXTURE_EXE;
  if (!helper || !fixture) {
    t.skip('Set MAKA_CU_WINDOWS_HELPER and MAKA_CU_WINDOWS_FIXTURE_EXE to run the fixture path');
    return;
  }
  const child = spawn(fixture, [], { stdio: ['ignore', 'ignore', 'ignore'] });
  let backend: ReturnType<typeof createWindowsCuBackend> | undefined;
  const traces: unknown[] = [];
  try {
    const expectedBinarySha256 = createHash('sha256')
      .update(await readFile(helper))
      .digest('hex');
    backend = createWindowsCuBackend({
      binaryPath: helper,
      expectedBinarySha256,
      onTrace: (event) => traces.push(event),
    });
    let apps = [] as Awaited<ReturnType<NonNullable<typeof backend.listApps>>>;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      apps = await backend.listApps!(new AbortController().signal);
      if (apps.some((app) => app.name?.toLowerCase().includes('maka-cu-windows-fixture'))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const fixtureApp = apps.find((app) =>
      app.name?.toLowerCase().includes('maka-cu-windows-fixture'),
    );
    assert.ok(fixtureApp, 'fixture window did not appear in list_apps');
    const context = { sessionId: 'dotnet-fixture', turnId: 'integration', toolCallId: 'observe' };
    let observation;
    try {
      observation = await backend.observeApp!(
        { app: fixtureApp.appId, includeScreenshot: true },
        new AbortController().signal,
        context,
      );
    } catch (error) {
      console.error(`Windows helper integration trace: ${JSON.stringify(traces)}`);
      throw error;
    }
    assert.ok(observation.screenshot?.base64, 'fixture observation did not include a WGC frame');
    const input = observation.elements.find((element) => element.role === 'edit');
    assert.ok(input, 'fixture UIA tree did not expose its edit control');
    const action = await backend.runSemantic!(
      {
        type: 'set_value',
        observationId: observation.observationId,
        elementId: input.elementId,
        value: 'host-integration-ok',
      },
      new AbortController().signal,
      context,
    );
    assert.equal(action.outcome.ok, true);
    const refreshed = await backend.observeApp!(
      { windowId: observation.windowId, includeScreenshot: false },
      new AbortController().signal,
      context,
    );
    assert.ok(
      refreshed.elements.some(
        (element) => element.role === 'edit' && element.value === 'host-integration-ok',
      ),
    );
  } finally {
    backend?.dispose();
    child.kill();
  }
});
