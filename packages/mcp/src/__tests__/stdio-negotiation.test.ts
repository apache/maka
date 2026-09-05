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
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';
import { MCP_CONFIG_VERSION, type McpConfigFile, type McpProtocolPreference } from '@maka/core/mcp';
import { McpClientManager } from '../index.js';

const legacyFixturePath = fileURLToPath(
  new URL('../__fixtures__/stdio-server.js', import.meta.url),
);
const dualEraFixturePath = fileURLToPath(
  new URL('../__fixtures__/dual-era-stdio-server.js', import.meta.url),
);
const managers: McpClientManager[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('McpClientManager stdio protocol negotiation', { concurrency: false }, () => {
  test('omitted and explicit legacy preferences each start exactly one child', async () => {
    for (const protocol of [undefined, 'legacy'] as const) {
      const fixture = await fixtureConfig('legacy', protocol);
      const manager = createManager();

      await manager.sync(fixture.config);

      assert.deepEqual(manager.status('fixture')?.negotiatedProtocol, {
        era: 'legacy',
        revision: '2025-11-25',
      });
      assert.equal(
        uniquePids(await waitForEvents(fixture.log, (events) => events.length > 0)).length,
        1,
      );
      await manager.close();
    }
  });

  test('auto probes a legacy server with a reaped sibling before the actual child', async () => {
    const fixture = await fixtureConfig('legacy', 'auto');
    const manager = createManager();

    await manager.sync(fixture.config);

    assert.deepEqual(manager.status('fixture')?.negotiatedProtocol, {
      era: 'legacy',
      revision: '2025-11-25',
    });
    const events = await waitForEvents(fixture.log, (current) => uniquePids(current).length === 2);
    assertProbeBeforeActual(events);
  });

  test('auto connects to a modern-only server after an isolated matching probe', async () => {
    const fixture = await fixtureConfig('modern-only', 'auto');
    const manager = createManager();

    await manager.sync(fixture.config);

    assert.deepEqual(manager.status('fixture')?.negotiatedProtocol, {
      era: 'modern',
      revision: '2026-07-28',
    });
    const events = await waitForEvents(fixture.log, (current) => uniquePids(current).length === 2);
    const [probePid, actualPid] = assertProbeBeforeActual(events);
    const starts = events.filter((event) => event.event === 'start');
    assert.equal(starts.length, 2);
    assert.deepEqual(
      starts.map(({ execPath, argv, cwd, fixtureEnv }) => ({ execPath, argv, cwd, fixtureEnv })),
      [
        {
          execPath: process.execPath,
          argv: [dualEraFixturePath, '--modern-only'],
          cwd: fixture.root,
          fixtureEnv: 'same-launch-input',
        },
        {
          execPath: process.execPath,
          argv: [dualEraFixturePath, '--modern-only'],
          cwd: fixture.root,
          fixtureEnv: 'same-launch-input',
        },
      ],
    );
    assert.equal(isPidAlive(probePid), false);
    assert.equal(isPidAlive(actualPid), true);
    assert.deepEqual(manager.status('fixture')?.stderrTail, [
      `stdio fixture dual-era pid=${actualPid}`,
    ]);

    await manager.close();
    await waitForEvents(fixture.log, (current) =>
      current.some((event) => event.event === 'exit' && event.pid === actualPid),
    );
    assert.equal(isPidAlive(actualPid), false);
  });

  test('an exact modern pin connects to a modern-only server without downgrade', async () => {
    const fixture = await fixtureConfig('modern-only', '2026-07-28');
    const manager = createManager();

    await manager.sync(fixture.config);

    assert.deepEqual(manager.status('fixture')?.negotiatedProtocol, {
      era: 'modern',
      revision: '2026-07-28',
    });
    const events = await waitForEvents(fixture.log, (current) => uniquePids(current).length === 2);
    const [probePid, actualPid] = assertProbeBeforeActual(events);
    assert.equal(isPidAlive(probePid), false);
    assert.equal(isPidAlive(actualPid), true);
  });

  test('an exact modern pin leaves no actual child after a legacy-only rejection', async () => {
    const fixture = await fixtureConfig('legacy', '2026-07-28');
    const manager = createManager();

    await manager.sync(fixture.config);

    assert.equal(manager.status('fixture')?.state, 'error');
    assert.equal(manager.status('fixture')?.negotiatedProtocol, undefined);
    assert.deepEqual(manager.toolSnapshot().tools, []);
    const events = await waitForEvents(fixture.log, (current) =>
      current.some((event) => event.event === 'exit'),
    );
    assert.equal(uniquePids(events).length, 1);
    assert.equal(isPidAlive(uniquePids(events)[0]!), false);
  });

  test('a pre-aborted auto connect starts no child', async () => {
    const fixture = await fixtureConfig('modern-only', 'auto');
    const manager = createManager();
    let cancelled = false;
    manager.onChange((status) => {
      if (!cancelled && status.serverId === 'fixture' && status.state === 'connecting') {
        cancelled = manager.cancelConnect('fixture');
      }
    });

    await manager.sync(fixture.config);

    assert.equal(cancelled, true);
    assert.equal(manager.status('fixture')?.state, 'disconnected');
    assert.deepEqual(await readEvents(fixture.log), []);
  });

  test('aborting during a delayed probe reaps it and never starts the actual child', async () => {
    const fixture = await fixtureConfig('modern-only', 'auto', {
      MAKA_MCP_STDIO_FACTORY_DELAY_MS: '30000',
    });
    const manager = createManager();
    const sync = manager.sync(fixture.config);
    await waitForEvents(fixture.log, (events) =>
      events.some((event) => event.event === 'factory' && event.era === 'modern'),
    );

    assert.equal(manager.cancelConnect('fixture'), true);
    await sync;

    const events = await waitForEvents(fixture.log, (current) =>
      current.some((event) => event.event === 'exit'),
    );
    assert.equal(uniquePids(events).length, 1);
    assert.equal(manager.status('fixture')?.state, 'disconnected');
    assert.equal(manager.status('fixture')?.negotiatedProtocol, undefined);
    assert.deepEqual(manager.toolSnapshot().tools, []);
  });
});

type StdioFixtureEvent = {
  event: string;
  fixture: string;
  pid: number;
  execPath?: string;
  argv?: string[];
  cwd?: string;
  fixtureEnv?: string | null;
  era?: 'legacy' | 'modern';
};

async function fixtureConfig(
  kind: 'legacy' | 'modern-only',
  protocol?: McpProtocolPreference,
  extraEnv: Record<string, string> = {},
): Promise<{ config: McpConfigFile; log: string; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-mcp-stdio-negotiation-')));
  roots.push(root);
  const log = join(root, 'events.jsonl');
  const fixturePath = kind === 'legacy' ? legacyFixturePath : dualEraFixturePath;
  const config: McpConfigFile = {
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [fixturePath, ...(kind === 'modern-only' ? ['--modern-only'] : [])],
        cwd: root,
        env: {
          MAKA_MCP_STDIO_EVENT_LOG: log,
          MAKA_MCP_STDIO_FIXTURE_VALUE: 'same-launch-input',
          ...extraEnv,
        },
        ...(protocol === undefined ? {} : { protocol }),
      },
    },
  };
  return { config, log, root };
}

function createManager(): McpClientManager {
  const manager = new McpClientManager({
    timeouts: { stdioConnectMs: 5_000, listToolsMs: 5_000, callToolMs: 5_000 },
  });
  managers.push(manager);
  return manager;
}

async function waitForEvents(
  path: string,
  predicate: (events: StdioFixtureEvent[]) => boolean,
  timeoutMs = 5_000,
): Promise<StdioFixtureEvent[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readEvents(path);
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const events = await readEvents(path);
  assert.fail(`timed out waiting for stdio fixture events: ${JSON.stringify(events)}`);
}

async function readEvents(path: string): Promise<StdioFixtureEvent[]> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return source
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StdioFixtureEvent);
}

function uniquePids(events: StdioFixtureEvent[]): number[] {
  return [...new Set(events.filter((event) => event.event === 'start').map((event) => event.pid))];
}

function assertProbeBeforeActual(events: StdioFixtureEvent[]): [number, number] {
  const pids = uniquePids(events);
  assert.equal(pids.length, 2, JSON.stringify(events));
  const [probePid, actualPid] = pids as [number, number];
  const probeExit = events.findIndex((event) => event.event === 'exit' && event.pid === probePid);
  const actualStart = events.findIndex(
    (event) => event.event === 'start' && event.pid === actualPid,
  );
  assert.ok(probeExit >= 0, JSON.stringify(events));
  assert.ok(probeExit < actualStart, JSON.stringify(events));
  return [probePid, actualPid];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
