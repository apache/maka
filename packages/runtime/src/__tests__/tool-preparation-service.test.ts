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
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';
import { ToolAuthorityRegistry } from '../preparation/tool-authority-registry.js';
import { ToolPreparationService } from '../preparation/tool-preparation-service.js';

describe('ToolPreparationService (single dispatch entry)', () => {
  let cwd: string;

  before(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-preparation-')));
  });

  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const context = (): MakaToolContext => ({
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd,
    permissionMode: 'ask',
    toolCallId: 'tool-call-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  });

  test('validates, canonicalises and dispatches through the authority registry', async () => {
    const seen: Array<{ args: unknown; cwd: string }> = [];
    const tool: MakaTool = {
      name: 'Write',
      description: 'test',
      parameters: z.object({ path: z.string(), content: z.string() }),
      impl: async () => ({ ok: true }),
    };

    const service = new ToolPreparationService(
      new ToolAuthorityRegistry([
        [
          'Write',
          {
            prepare: async (args, ctx) => {
              seen.push({ args, cwd: ctx.cwd });
              return {
                claims: [
                  {
                    kind: 'keyed',
                    authority: 'filesystem:workspace',
                    key: '/repo/a.ts',
                    mode: 'write',
                  },
                ],
                execute: async () => ({ ok: true }),
              };
            },
          },
        ],
      ]),
    );
    const operation = await service.prepare({
      tool,
      input: { path: 'a.ts', content: 'x' },
      ctx: context(),
    });

    assert.equal(operation.claims.length, 1);
    assert.equal(seen.length, 1);
    // The canonical cwd is the realpath'd one and the input snapshot is frozen.
    assert.equal(seen[0]?.cwd, cwd);
    assert.ok(Object.isFrozen(seen[0]!.args));
  });

  test('schema-invalid args produce a no-claim operation (execute rejects)', async () => {
    const tool: MakaTool = {
      name: 'Write',
      description: 'test',
      parameters: z.object({ path: z.string(), content: z.string() }),
      impl: async () => ({}),
    };

    const service = new ToolPreparationService(
      new ToolAuthorityRegistry([
        [
          'Write',
          {
            prepare: async () => {
              throw new Error('must not be dispatched');
            },
          },
        ],
      ]),
    );
    const operation = await service.prepare({ tool, input: { path: 'a.ts' }, ctx: context() });
    assert.deepEqual(operation.claims, []);
    await assert.rejects(operation.execute(), /could not be prepared/);
  });

  test('a real tool with no registered authority falls back to all()', async () => {
    let ran = 0;
    const tool: MakaTool = {
      name: 'Untracked',
      description: 'test',
      parameters: z.object({ command: z.string() }),
      impl: async () => {
        ran += 1;
        return { done: true };
      },
    };

    const service = new ToolPreparationService(new ToolAuthorityRegistry());
    const operation = await service.prepare({
      tool,
      input: { command: 'echo hi' },
      ctx: context(),
    });
    assert.deepEqual(operation.claims, [{ kind: 'all' }]);
    await operation.execute();
    assert.equal(ran, 1);
    await assert.rejects(operation.execute(), /already been executed/);
    assert.equal(ran, 1);
  });

  test('canonicalising does not freeze the live AbortSignal', async () => {
    const controller = new AbortController();
    const tool: MakaTool = {
      name: 'Signal',
      description: 'test',
      parameters: z.object({ value: z.string() }),
      impl: async () => undefined,
    };

    const service = new ToolPreparationService(
      new ToolAuthorityRegistry([
        ['Signal', { prepare: async () => ({ claims: [], execute: async () => undefined }) }],
      ]),
    );
    await service.prepare({
      tool,
      input: { value: 'x' },
      ctx: { ...context(), abortSignal: controller.signal },
    });
    // A deep-freeze of the context would have made this throw.
    controller.abort(new Error('still live'));
    assert.equal(controller.signal.aborted, true);
  });

  test('rejects duplicate canonical tool registrations', () => {
    const authority = { prepare: async () => ({ claims: [], execute: async () => undefined }) };
    assert.throws(
      () =>
        new ToolAuthorityRegistry([
          ['Write', authority],
          ['Write', authority],
        ]),
      /already registered: Write/,
    );
  });

  test('extends registries immutably and still rejects duplicate ids', () => {
    const first = { prepare: async () => ({ claims: [], execute: async () => undefined }) };
    const second = { prepare: async () => ({ claims: [], execute: async () => undefined }) };
    const base = new ToolAuthorityRegistry([['first', first]]);
    const extended = base.withRegistrations([['second', second]]);
    assert.equal(base.has('first'), true);
    assert.equal(base.has('second'), false);
    assert.equal(extended.has('first'), true);
    assert.equal(extended.has('second'), true);
    assert.throws(() => base.withRegistrations([['first', second]]), /already registered: first/);
  });
});
