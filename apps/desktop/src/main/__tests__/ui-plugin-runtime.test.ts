import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionUiContributionProjection } from '@maka/runtime-host/protocol';
import { UiPluginRuntime } from '../../renderer/ui-plugin-runtime.js';

test('Client Cordis tree updates one UI entry without remounting siblings', async () => {
  const runtime = new UiPluginRuntime();
  const first = contribution('first', 1, 'one');
  const sibling = contribution('sibling', 1, 'sibling');
  await runtime.reconcile([first, sibling]);
  assert.deepEqual(runtime.inspect().map(({ entryId, generation }) => [entryId, generation]), [
    ['first', 1],
    ['sibling', 1],
  ]);
  await runtime.reconcile([contribution('first', 2, 'two'), sibling]);
  assert.deepEqual(runtime.inspect().map(({ entryId, generation }) => [entryId, generation]), [
    ['first', 2],
    ['sibling', 1],
  ]);
  await runtime.reconcile([sibling]);
  assert.deepEqual(runtime.inspect().map(({ entryId }) => entryId), ['sibling']);
  await runtime.close();
});

function contribution(
  entryId: string,
  generation: number,
  id: string,
): ExtensionUiContributionProjection {
  return Object.freeze({
    entryId,
    extensionId: `fixture.${entryId}`,
    generation,
    id,
    surface: 'app.overlay',
    priority: 0,
    document: '<!doctype html>',
    documentSha256: `${id}-${generation}`,
    network: false,
  });
}
