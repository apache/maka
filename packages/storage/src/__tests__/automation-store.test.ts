import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAutomationStore } from '../automation-store.js';

interface TestRecord {
  id: string;
  name: string;
  status?: string;
}

const TEST_DIR = join(tmpdir(), `maka-automation-store-test-${process.pid}`);

describe('AutomationStore', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test('loadAll returns empty array when file does not exist', async () => {
    const store = createAutomationStore<TestRecord>(TEST_DIR);
    const result = await store.loadAll();
    assert.deepEqual(result, []);
  });

  test('save persists automation to disk', async () => {
    const store = createAutomationStore<TestRecord>(TEST_DIR);
    await store.save({ id: 'auto-1', name: 'test', status: 'active' });

    const raw = await readFile(join(TEST_DIR, 'automations.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.automations.length, 1);
    assert.equal(parsed.automations[0].id, 'auto-1');
  });

  test('loadAll reads back saved automations', async () => {
    const store = createAutomationStore<TestRecord>(TEST_DIR);
    await store.save({ id: 'auto-1', name: 'first' });
    await store.save({ id: 'auto-2', name: 'second' });

    const result = await store.loadAll();
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'auto-1');
    assert.equal(result[1].id, 'auto-2');
  });

  test('save updates existing automation by id', async () => {
    const store = createAutomationStore<TestRecord>(TEST_DIR);
    await store.save({ id: 'auto-1', name: 'original' });
    await store.save({ id: 'auto-1', name: 'updated' });

    const result = await store.loadAll();
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'updated');
  });

  test('remove deletes automation from file', async () => {
    const store = createAutomationStore<TestRecord>(TEST_DIR);
    await store.save({ id: 'auto-1', name: 'a' });
    await store.save({ id: 'auto-2', name: 'b' });

    await store.remove('auto-1');
    const result = await store.loadAll();
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'auto-2');
  });

  test('remove with nonexistent id is a no-op', async () => {
    const store = createAutomationStore<TestRecord>(TEST_DIR);
    await store.save({ id: 'auto-1', name: 'a' });

    await store.remove('nonexistent');
    const result = await store.loadAll();
    assert.equal(result.length, 1);
  });

  test('sync replaces all automations at once', async () => {
    const store = createAutomationStore<TestRecord>(TEST_DIR);
    await store.save({ id: 'old-1', name: 'old' });

    await store.sync([
      { id: 'new-1', name: 'alpha' },
      { id: 'new-2', name: 'beta' },
    ]);

    const result = await store.loadAll();
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'new-1');
    assert.equal(result[1].id, 'new-2');
  });

  test('loadAll FAILS LOUD on a corrupt file (never masks unreadable data as empty)', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(TEST_DIR, 'automations.json'), 'not valid json{{{', 'utf8');

    const store = createAutomationStore<TestRecord>(TEST_DIR);
    // Returning [] here would let a subsequent full-overwrite sync erase real data.
    await assert.rejects(() => store.loadAll(), /not valid JSON/);
  });

  test('loadAll FAILS LOUD on an unrecognized version/shape', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(TEST_DIR, 'automations.json'),
      JSON.stringify({ version: 99, automations: [] }),
      'utf8',
    );

    const store = createAutomationStore<TestRecord>(TEST_DIR);
    await assert.rejects(() => store.loadAll(), /unrecognized shape or version/);
  });

  test('atomic write: file is not corrupted on concurrent saves', async () => {
    const store = createAutomationStore<TestRecord>(TEST_DIR);
    await Promise.all([
      store.save({ id: 'a', name: 'alpha' }),
      store.save({ id: 'b', name: 'beta' }),
      store.save({ id: 'c', name: 'gamma' }),
    ]);

    const result = await store.loadAll();
    assert.deepEqual(
      [...result].sort((left, right) => left.id.localeCompare(right.id)),
      [
        { id: 'a', name: 'alpha' },
        { id: 'b', name: 'beta' },
        { id: 'c', name: 'gamma' },
      ],
    );
  });
});
