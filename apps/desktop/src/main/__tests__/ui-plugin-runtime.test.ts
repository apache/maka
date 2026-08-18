import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionUiContributionProjection } from '@maka/runtime-host/protocol';
import { UiPluginRuntime } from '../../renderer/ui-plugin-runtime.js';

test('Client Cordis tree updates one UI entry without remounting siblings', async () => {
  const runtime = new UiPluginRuntime();
  const first = contribution('first', 'r1', 'one');
  const sibling = contribution('sibling', 'r1', 'sibling');
  await runtime.reconcile([first, sibling]);
  assert.deepEqual(runtime.inspect().map(({ entryId, revision }) => [entryId, revision]), [
    ['first', 'r1'],
    ['sibling', 'r1'],
  ]);
  await runtime.reconcile([contribution('first', 'r2', 'two'), sibling]);
  assert.deepEqual(runtime.inspect().map(({ entryId, revision }) => [entryId, revision]), [
    ['first', 'r2'],
    ['sibling', 'r1'],
  ]);
  await runtime.reconcile([sibling]);
  assert.deepEqual(runtime.inspect().map(({ entryId }) => entryId), ['sibling']);
  await runtime.close();
});

function contribution(
  entryId: string,
  revision: string,
  id: string,
): ExtensionUiContributionProjection {
  return Object.freeze({
    entryId,
    extensionId: `fixture.${entryId}`,
    revision,
    id,
    surface: 'app.overlay',
    priority: 0,
    document: '<!doctype html>',
    documentSha256: `${id}-${revision}`,
    network: false,
  });
}
