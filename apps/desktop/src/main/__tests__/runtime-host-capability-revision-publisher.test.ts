import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityRevisionPublisher } from '../runtime-host-capability-revision-publisher.js';

test('publishes an offline revision to the replacement candidate generation', async () => {
  let revision = 1;
  const publications: string[] = [];
  const publisher = createCapabilityRevisionPublisher(() => revision);
  const first = publisher.bind(async () => {
    publications.push(`first:${revision}`);
  });
  await first.aligned;
  first.dispose();

  revision = 2;
  await publisher.refreshIfChanged();
  assert.deepEqual(publications, ['first:1']);

  const replacement = publisher.bind(async () => {
    publications.push(`replacement:${revision}`);
  });
  await replacement.aligned;
  assert.deepEqual(publications, ['first:1', 'replacement:2']);
});

test('does not let a retired candidate confirm an in-flight publication', async () => {
  let revision = 1;
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstPublication = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const publications: string[] = [];
  const publisher = createCapabilityRevisionPublisher(() => revision);
  const first = publisher.bind(async () => {
    publications.push(`first:${revision}`);
    markFirstStarted?.();
    await firstPublication;
  });

  await firstStarted;
  first.dispose();
  revision = 2;
  const replacement = publisher.bind(async () => {
    publications.push(`replacement:${revision}`);
  });
  releaseFirst?.();
  await first.aligned;
  await replacement.aligned;

  assert.deepEqual(publications, ['first:1', 'replacement:2']);
  await publisher.refreshIfChanged();
  assert.deepEqual(publications, ['first:1', 'replacement:2']);
});
