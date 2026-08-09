import assert from 'node:assert/strict';
import test from 'node:test';
import { formatGitHubOutputs, loadWorkspaceGraph, planTests } from './ci-test-plan.mjs';

const graph = loadWorkspaceGraph();

test('impact planning distinguishes docs, UI, and backend changes', () => {
  const docs = planTests(['README.md', 'docs/testing.md'], { graph });
  assert.equal(docs.code, false);
  assert.deepEqual(docs.workspaces, []);

  const ui = planTests(['packages/ui/src/button.tsx'], { graph });
  assert.equal(ui.e2e, true);
  // Product UI is mounted by the catalog. Runtime export and render changes can
  // break Storybook even when its story files themselves are unchanged.
  assert.equal(ui.storybook, true);
  assert.equal(ui.scriptMode, 'none');
  assert.deepEqual(ui.workspaces, ['packages/ui', 'apps/desktop']);

  // Unit-only packages/ui edits still run workspace tests, but must not force
  // cold Electron e2e or Storybook build+Chromium smoke.
  const uiUnitOnly = planTests(['packages/ui/src/__tests__/tool-activity-presentation.test.ts'], {
    graph,
  });
  assert.equal(uiUnitOnly.e2e, false);
  assert.equal(uiUnitOnly.storybook, false);
  assert.ok(uiUnitOnly.workspaces.includes('packages/ui'));
  assert.equal(planTests(['packages/ui/src/composer.tsx'], { graph }).e2e, true);

  // Renderer code is mounted by product stories; main-process and e2e files are not.
  assert.equal(
    planTests(['apps/desktop/src/renderer/settings/daily-review-settings-page.tsx'], {
      graph,
    }).storybook,
    true,
  );
  assert.equal(planTests(['apps/desktop/src/main/main.ts'], { graph }).storybook, false);
  assert.equal(planTests(['apps/desktop/e2e/settings.spec.ts'], { graph }).storybook, false);
  assert.equal(planTests(['apps/desktop/e2e/settings.spec.ts'], { graph }).e2e, true);

  // Catalog + harness changes build and render the catalog without paying for
  // workspace tests or real-window Electron E2E.
  for (const path of [
    'apps/desktop/stories/app-shell.stories.tsx',
    'apps/desktop/stories/FIDELITY.md',
    'apps/desktop/.storybook/preview.tsx',
    'packages/ui/stories/composer.stories.tsx',
  ]) {
    const catalog = planTests([path], { graph });
    assert.equal(catalog.storybook, true, path);
    assert.equal(catalog.e2e, false, path);
    assert.deepEqual(catalog.workspaces, [], path);
  }

  // .storybook/preview.tsx reads THEME_PALETTES from this one core module.
  // Other core paths must not force Storybook.
  const coreSettings = planTests(['packages/core/src/settings.ts'], { graph });
  assert.equal(coreSettings.storybook, true);
  assert.equal(coreSettings.e2e, false);
  assert.equal(planTests(['packages/core/src/index.ts'], { graph }).storybook, false);

  // A script the Storybook job RUNS must re-run Storybook, not Electron e2e.
  const smoke = planTests(['scripts/storybook-visual-smoke.mjs'], { graph });
  assert.equal(smoke.storybook, true);
  assert.equal(smoke.e2e, false);
  assert.equal(smoke.scriptMode, 'fast');
  assert.equal(planTests(['scripts/check-story-annotations.mjs'], { graph }).e2e, false);
  assert.equal(planTests(['scripts/check-story-annotations.mjs'], { graph }).storybook, false);

  // Alignment auditor drives the e2e job (not Storybook).
  const alignment = planTests(['scripts/audit-alignment.mjs'], { graph });
  assert.equal(alignment.e2e, true);
  assert.equal(alignment.storybook, false);

  const backend = planTests(['packages/storage/src/session-store.ts'], { graph });
  assert.equal(backend.e2e, false);
  assert.equal(backend.storybook, false);
  for (const workspace of ['packages/storage', 'packages/runtime', 'apps/desktop']) {
    assert.ok(backend.workspaces.includes(workspace));
  }
});

test('stress and specialized script checks run only for their owning surfaces', () => {
  for (const path of [
    'packages/storage/src/agent-run-store.ts',
    'packages/storage/src/git-workspace-service.ts',
    'packages/storage/src/__tests__/fixtures/git-workspace-service-crash-child.ts',
    'packages/storage/src/root-authority.ts',
    'packages/storage/src/__tests__/root-authority.test.ts',
    'packages/storage/src/__tests__/fixtures/root-lock-holder.ts',
    // The amplified fresh-WAL race: the test, its worker, and the production
    // owners of WAL initialization, locking, and every migration that
    // acquireOperationalStateDatabase() runs inside the race.
    'packages/storage/src/operational-state-store.ts',
    'packages/storage/src/sqlite-artifact-schema.ts',
    'packages/storage/src/sqlite-automation-schema.ts',
    'packages/storage/src/sqlite-core-execution-schema.ts',
    'packages/storage/src/sqlite-runtime-schema.ts',
    'packages/storage/src/sqlite-session-metadata-schema.ts',
    'packages/storage/src/sqlite-usage-schema.ts',
    'packages/storage/src/sqlite-workflow-schema.ts',
    'packages/storage/src/__tests__/sqlite-recovery-concurrency.test.ts',
    'packages/storage/src/__tests__/fixtures/sqlite-recovery-concurrency-child.ts',
  ]) {
    assert.equal(planTests([path], { graph }).storageStress, true, path);
  }
  assert.equal(
    planTests(['packages/storage/src/session-store.ts'], { graph }).storageStress,
    false,
  );
  // Imported by the race worker for its other modes, but the amplified
  // operational_open_only branch never constructs it — not a stress trigger.
  assert.equal(
    planTests(['packages/storage/src/sqlite-runtime-store.ts'], { graph }).storageStress,
    false,
  );
  assert.equal(planTests([], { graph, forceFull: true }).storageStress, false);
  for (const path of [
    'scripts/fixture-env.mjs',
    'scripts/ci-test-plan.test.mjs',
    'scripts/run-workspace-tests-parallel.test.mjs',
  ]) {
    const plan = planTests([path], { graph });
    assert.equal(plan.full, false, path);
    assert.equal(plan.scriptMode, 'fast', path);
  }
  const measurement = planTests(['scripts/measure-session-bundle.mjs'], { graph });
  assert.equal(measurement.scriptMode, 'extended');
  assert.deepEqual(measurement.workspaces, []);
});

test('release tooling and the release config select the checks that cover them', () => {
  const graph = loadWorkspaceGraph();
  // These run only on release day, so CI has to select their tests from the
  // change itself; verify-packaged-app.mjs is shared, and a change there reaches
  // the macOS release path without touching anything macOS-specific.
  for (const path of [
    'scripts/npm-spawn.mjs',
    'scripts/package-windows-x64.mjs',
    'scripts/verify-windows-x64.mjs',
    'scripts/windows-x64-release.test.mjs',
    'scripts/verify-packaged-app.mjs',
    'scripts/verify-macos-arm64-dmg.mjs',
  ]) {
    assert.equal(planTests([path], { graph }).scriptMode, 'extended', path);
  }
  // electron-builder rejects an unknown option outright, and only
  // scripts/electron-builder-config.test.mjs would notice before release day.
  const releaseConfig = planTests(['apps/desktop/electron-builder.config.mjs'], { graph });
  assert.equal(releaseConfig.scriptMode, 'fast');
  assert.ok(releaseConfig.workspaces.includes('apps/desktop'));
});

test('sandbox is flagged whenever the cli workspace runs in the closure', () => {
  // The Runtime Host CLI controls sandboxed shell resources, so any change whose
  // dependency closure selects packages/cli must provision the sandbox.
  for (const path of [
    'packages/cli/src/__tests__/runtime-host-session-driver.test.ts',
    'packages/runtime/src/shell-tools.ts',
    'packages/storage/src/session-store.ts',
    'packages/headless/src/cell-output.ts',
  ]) {
    assert.equal(planTests([path], { graph }).runtimeSandbox, true, path);
  }
});

test('heavy workspaces are projected onto dedicated CI lanes', () => {
  const runtimeHost = planTests(['packages/runtime-host/src/server/index.ts'], { graph });
  assert.equal(runtimeHost.runtimeHost, true);
  assert.equal(runtimeHost.headless, false);
  assert.deepEqual(runtimeHost.standardWorkspaces, ['packages/cli', 'apps/desktop']);

  const runtime = planTests(['packages/runtime/src/index.ts'], { graph });
  assert.equal(runtime.runtimeHost, true);
  assert.equal(runtime.headless, true);
  assert.deepEqual(runtime.standardWorkspaces, [
    'packages/runtime',
    'packages/computer-use',
    'packages/cli',
    'apps/desktop',
  ]);

  const full = planTests([], { graph, forceFull: true });
  assert.equal(full.runtimeHost, true);
  assert.equal(full.headless, true);
  assert.deepEqual(
    full.standardWorkspaces,
    graph.dirs.filter((dir) => dir !== 'packages/runtime-host' && dir !== 'packages/headless'),
  );

  const outputs = formatGitHubOutputs(runtimeHost).split('\n');
  assert.ok(outputs.includes('runtime_host=true'));
  assert.ok(outputs.includes('headless=false'));
  assert.ok(outputs.includes('standard_workspaces=packages/cli,apps/desktop'));
});

test('global and unknown production changes fail safe to the complete suite', () => {
  for (const path of ['package-lock.json', 'scripts/ci-test-plan.mjs', 'new-root/file.ts']) {
    const plan = planTests([path], { graph });
    assert.equal(plan.full, true);
    assert.equal(plan.e2e, true);
    assert.equal(plan.storybook, true);
    assert.equal(plan.storageStress, false);
    assert.deepEqual(plan.workspaces, graph.dirs);
  }
});
