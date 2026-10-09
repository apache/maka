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
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createSessionStore } from '@maka/storage/session-store';
import type { StoredMessage } from '@maka/core/session';
import { runMakaSessionExportMarkdownCli } from '../session-export-markdown-command.js';

const CLEANUPS: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (CLEANUPS.length > 0) {
    await CLEANUPS.pop()!();
  }
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'session-export-markdown-cli-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  CLEANUPS.push(() => rm(root, { recursive: true, force: true }));
  return workspaceRoot;
}

async function seedSession(workspaceRoot: string): Promise<string> {
  const store = createSessionStore(workspaceRoot);
  try {
    const header = await store.create({
      cwd: workspaceRoot,
      llmConnectionSlug: 'test-connection',
      model: 'test-model',
      permissionMode: 'ask',
      name: 'CLI export',
    });
    const messages: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 'turn-1', ts: 1, text: 'hello' },
      {
        type: 'assistant',
        id: 'a1',
        turnId: 'turn-1',
        ts: 2,
        text: 'Hi there.',
        modelId: 'test-model',
      },
    ];
    await store.appendMessages(header.id, messages);
    return header.id;
  } finally {
    await store.close?.();
  }
}

describe('maka session-export-markdown', () => {
  test('writes the transcript and exits 0', async () => {
    const workspaceRoot = await makeWorkspace();
    const sessionId = await seedSession(workspaceRoot);
    const destination = join(workspaceRoot, 'transcript.md');

    const exit = await runMakaSessionExportMarkdownCli([
      '--workspace-root',
      workspaceRoot,
      '--session',
      sessionId,
      '--out',
      destination,
    ]);

    assert.equal(exit, 0);
    const markdown = await readFile(destination, 'utf8');
    assert.ok(markdown.startsWith('# CLI export\n'));
    assert.ok(markdown.includes('## You'));
    assert.ok(markdown.includes('hello'));
    assert.ok(markdown.includes('## Maka'));
    assert.ok(markdown.includes('Hi there.'));
  });

  test('never overwrites an existing file', async () => {
    const workspaceRoot = await makeWorkspace();
    const sessionId = await seedSession(workspaceRoot);
    const destination = join(workspaceRoot, 'keep.md');
    await writeFile(destination, 'do not touch\n', 'utf8');

    const exit = await runMakaSessionExportMarkdownCli([
      '--workspace-root',
      workspaceRoot,
      '--session',
      sessionId,
      '--out',
      destination,
    ]);

    assert.equal(exit, 5);
    assert.equal(await readFile(destination, 'utf8'), 'do not touch\n');
  });

  test('reports a missing session with exit code 2', async () => {
    const workspaceRoot = await makeWorkspace();
    const destination = join(workspaceRoot, 'absent.md');

    const exit = await runMakaSessionExportMarkdownCli([
      '--workspace-root',
      workspaceRoot,
      '--session',
      'does-not-exist',
      '--out',
      destination,
    ]);

    assert.equal(exit, 2);
    assert.equal(
      await readFile(destination, 'utf8').then(
        () => 'written',
        () => 'absent',
      ),
      'absent',
    );
  });

  test('rejects missing arguments with exit code 1', async () => {
    assert.equal(await runMakaSessionExportMarkdownCli(['--session', 's1']), 1);
    assert.equal(await runMakaSessionExportMarkdownCli([]), 1);
  });
});
