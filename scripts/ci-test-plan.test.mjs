import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWorkspaceGraph, planTests } from './ci-test-plan.mjs';

const graph = loadWorkspaceGraph();

test('impact planning distinguishes docs, UI, and backend changes', () => {
  const docs = planTests(['README.md', 'docs/testing.md'], { graph });
  assert.equal(docs.code, false);
  assert.deepEqual(docs.workspaces, []);

  const ui = planTests(['packages/ui/src/button.tsx'], { graph });
  assert.equal(ui.e2e, true);
  assert.equal(ui.scriptMode, 'none');
  assert.deepEqual(ui.workspaces, ['packages/ui', 'apps/desktop']);

  const backend = planTests(['packages/storage/src/session-store.ts'], { graph });
  assert.equal(backend.e2e, false);
  for (const workspace of ['packages/storage', 'packages/runtime', 'apps/desktop']) {
    assert.ok(backend.workspaces.includes(workspace));
  }
});

test('stress and specialized script checks run only for their owning surfaces', () => {
  assert.equal(
    planTests(['packages/storage/src/agent-run-store.ts'], { graph }).storageStress,
    true,
  );
  assert.equal(planTests(['scripts/fixture-env.mjs'], { graph }).scriptMode, 'fast');
  const measurement = planTests(['scripts/measure-session-bundle.mjs'], { graph });
  assert.equal(measurement.scriptMode, 'extended');
  assert.deepEqual(measurement.workspaces, []);
});

test('global and unknown production changes fail safe to the complete suite', () => {
  for (const path of ['package-lock.json', 'scripts/ci-test-plan.mjs', 'new-root/file.ts']) {
    const plan = planTests([path], { graph });
    assert.equal(plan.full, true);
    assert.equal(plan.e2e, true);
    assert.deepEqual(plan.workspaces, graph.dirs);
  }
});
