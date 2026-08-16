import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createBrowserWorkflowStore } from '../browser-workflow-store.js';
import type { BrowserWorkflow } from '@maka/core/browser-workflow';

function makeWorkflow(id: string): BrowserWorkflow {
  return {
    schemaVersion: 1,
    id,
    name: `Workflow ${id}`,
    createdAt: 1,
    updatedAt: 1,
    actions: [{ id: `${id}-navigate`, kind: 'navigate', url: 'https://example.test/' }],
  };
}

describe('BrowserWorkflowStore', () => {
  test('persists, updates, lists, and removes workflows in browser-workflows.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-browser-workflow-'));
    try {
      const store = createBrowserWorkflowStore(root);
      await store.save(makeWorkflow('one'));
      await store.save({ ...makeWorkflow('one'), name: 'Renamed', updatedAt: 2 });
      await store.save(makeWorkflow('two'));
      assert.equal((await store.get('one'))?.name, 'Renamed');
      assert.deepEqual(
        (await store.loadAll()).map((entry) => entry.id),
        ['one', 'two'],
      );
      const raw = JSON.parse(await readFile(join(root, 'browser-workflows.json'), 'utf8'));
      assert.equal(raw.version, 1);
      assert.equal(raw.workflows.length, 2);
      await store.remove('one');
      assert.deepEqual(
        (await store.loadAll()).map((entry) => entry.id),
        ['two'],
      );
      const restartedStore = createBrowserWorkflowStore(root);
      assert.equal((await restartedStore.get('two'))?.name, 'Workflow two');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed on corrupt or invalid workflow data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-browser-workflow-'));
    try {
      await writeFile(join(root, 'browser-workflows.json'), '{broken', 'utf8');
      await assert.rejects(() => createBrowserWorkflowStore(root).loadAll(), /not valid JSON/);
      await writeFile(
        join(root, 'browser-workflows.json'),
        JSON.stringify({ version: 1, workflows: [{ id: 'bad' }] }),
        'utf8',
      );
      await assert.rejects(
        () => createBrowserWorkflowStore(root).loadAll(),
        /unrecognized shape or version/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
