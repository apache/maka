import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostChangeFeed } from '../server/host-change-feed.js';

test('routes each change kind only to subscribed connections', () => {
  const feed = new HostChangeFeed();
  const configuration: unknown[] = [];
  const project: unknown[] = [];
  const all: unknown[] = [];
  feed.attachConnection(
    'configuration',
    { configuration: true },
    { send: async (frame) => void configuration.push(frame) },
  );
  feed.attachConnection(
    'project',
    { projectCatalog: true },
    { send: async (frame) => void project.push(frame) },
  );
  feed.attachConnection(
    'all',
    { configuration: true, projectCatalog: true, sessionCatalog: true, scheduledTask: true },
    { send: async (frame) => void all.push(frame) },
  );

  feed.publishConfiguration();
  feed.publishProjectCatalog();
  feed.publishSessionCatalog('session-1');
  feed.publishScheduledTask(7, 'updated', 'task-1');

  assert.deepEqual(
    configuration.map((frame) => (frame as { kind: string }).kind),
    ['configuration.changed'],
  );
  assert.deepEqual(
    project.map((frame) => (frame as { kind: string }).kind),
    ['project.catalog.changed'],
  );
  assert.equal(all.length, 4);
});

test('keeps catalog revisions independent and removes failed subscriptions', async () => {
  const feed = new HostChangeFeed();
  const frames: unknown[] = [];
  feed.attachConnection(
    'working',
    { projectCatalog: true, sessionCatalog: true },
    { send: async (frame) => void frames.push(frame) },
  );
  feed.attachConnection(
    'failed',
    { projectCatalog: true },
    {
      send: async () => {
        throw new Error('closed');
      },
    },
  );

  feed.publishProjectCatalog();
  feed.publishSessionCatalog('session-1');
  await Promise.resolve();
  feed.publishProjectCatalog();

  assert.deepEqual(
    frames.map((frame) => (frame as { kind: string; revision: number }).revision),
    [1, 1, 2],
  );
});
