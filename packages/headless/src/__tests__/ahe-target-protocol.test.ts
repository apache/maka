import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  MAKA_AHE_CURRENT_COMPONENTS,
  MAKA_AHE_RUN_RESULT_SCHEMA_VERSION,
  MAKA_AHE_TARGET_PROTOCOL_VERSION,
  MAKA_AHE_TARGET_PROTOCOL_VERSION_V1,
  makaAheSourceManifestDigest,
  makaAheTargetSnapshotId,
  validateMakaAheChangeManifest,
  validateMakaAheRunResult,
  validateMakaAheTargetComponents,
  validateMakaAheTargetSnapshot,
} from '../ahe-target-protocol.js';
import {
  INVALID_MAKA_AHE_CHANGE_MANIFEST,
  INVALID_MAKA_AHE_COMPONENTS,
  VALID_MAKA_AHE_CHANGE_MANIFEST,
} from './ahe-target-protocol.fixtures.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('AHE target protocol', () => {
  it('accepts the current Maka component map', () => {
    const result = validateMakaAheTargetComponents(MAKA_AHE_CURRENT_COMPONENTS);

    assert.equal(result.ok, true);
  });

  it('pins every component source ref to a file that exists in the repo', () => {
    const missing = MAKA_AHE_CURRENT_COMPONENTS.flatMap((component) =>
      component.sourceRefs
        .filter((sourceRef) => !existsSync(join(repoRoot, sourceRef.path)))
        .map((sourceRef) => `${component.id}: ${sourceRef.path}`),
    );

    assert.deepEqual(missing, []);
  });

  it('validates content-addressed v2 snapshots and detects manifest tampering', () => {
    const components = [MAKA_AHE_CURRENT_COMPONENTS[0]!];
    const entries = components[0]!.sourceRefs.map((sourceRef) => ({
      componentId: components[0]!.id,
      path: sourceRef.path,
      ...(sourceRef.exportName ? { exportName: sourceRef.exportName } : {}),
      digest: `sha256:${'a'.repeat(64)}`,
      sizeBytes: 42,
    }));
    const sourceManifest = {
      algorithm: 'sha256' as const,
      digest: makaAheSourceManifestDigest(entries),
      entries,
    };
    const snapshot = {
      protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
      sourceLabel: 'test',
      snapshotId: makaAheTargetSnapshotId(components, sourceManifest),
      createdAt: '2026-07-14T00:00:00.000Z',
      components,
      sourceManifest,
    };

    assert.equal(validateMakaAheTargetSnapshot(snapshot).ok, true);
    const tampered = validateMakaAheTargetSnapshot({
      ...snapshot,
      sourceManifest: {
        ...sourceManifest,
        entries: [{ ...entries[0]!, digest: `sha256:${'b'.repeat(64)}` }, ...entries.slice(1)],
      },
    });
    assert.equal(tampered.ok, false);
    if (!tampered.ok) {
      assert(tampered.errors.some((error) => error.path === 'sourceManifest.digest'));
    }
  });

  it('reads legacy v1 snapshots without claiming content binding', () => {
    const result = validateMakaAheTargetSnapshot({
      protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION_V1,
      sourceLabel: 'legacy-exporter',
      snapshotId: 'maka-ahe-legacy-id',
      createdAt: '2026-07-01T00:00:00.000Z',
      components: [MAKA_AHE_CURRENT_COMPONENTS[0]],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.protocolVersion, 'maka.ahe-target.v1');
      assert.equal('sourceManifest' in result.value, false);
    }
  });

  it('rejects invalid component maps', () => {
    const result = validateMakaAheTargetComponents(INVALID_MAKA_AHE_COMPONENTS);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.path === 'components[0].category'));
      assert(result.errors.some((error) => error.path === 'components[1].id'));
      assert(result.errors.some((error) => error.path === 'components[1].sourceRefs'));
    }
  });

  it('accepts a source-backed change manifest', () => {
    const result = validateMakaAheChangeManifest(VALID_MAKA_AHE_CHANGE_MANIFEST);

    assert.equal(result.ok, true);
  });

  it('uses the same audit field names and binds every changed component to the edited surface', () => {
    const result = validateMakaAheChangeManifest({
      ...VALID_MAKA_AHE_CHANGE_MANIFEST,
      editedSurface: 'tool_contract',
      changedComponents: ['maka-tool-contracts', 'maka-system-prompt'],
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.path === 'editedSurface'));
    }
  });

  it('lets the heavy-task component patch its policy owner', () => {
    const result = validateMakaAheChangeManifest({
      ...VALID_MAKA_AHE_CHANGE_MANIFEST,
      editedSurface: 'heavy_task_policy',
      changedComponents: ['maka-heavy-task-policy'],
      patch: {
        applyMode: 'staged_patch',
        changedFiles: ['packages/headless/src/heavy-task-policy.ts'],
      },
    });

    assert.equal(result.ok, true);
  });

  it('rejects manifests that target unknown components or omit falsifiable evidence', () => {
    const result = validateMakaAheChangeManifest(INVALID_MAKA_AHE_CHANGE_MANIFEST);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.path === 'changedComponents[0]'));
      assert(result.errors.some((error) => error.path === 'predictedFixes'));
      assert(result.errors.some((error) => error.path === 'rollbackCriteria'));
    }
  });

  it('rejects manifests that try to patch evidence-only components', () => {
    const result = validateMakaAheChangeManifest({
      ...VALID_MAKA_AHE_CHANGE_MANIFEST,
      editedSurface: 'runtime_evidence',
      changedComponents: ['maka-runtime-evidence'],
      patch: {
        applyMode: 'staged_patch',
        changedFiles: ['packages/core/src/runtime-event.ts'],
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.message.includes('evidence-only')));
    }
  });

  it('rejects patch paths outside changed editable component source refs', () => {
    const result = validateMakaAheChangeManifest({
      ...VALID_MAKA_AHE_CHANGE_MANIFEST,
      editedSurface: 'system_prompt',
      changedComponents: ['maka-system-prompt'],
      patch: {
        applyMode: 'staged_patch',
        changedFiles: ['packages/runtime/src/tool-runtime.ts'],
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.path === 'patch.changedFiles[0]'));
    }
  });

  it('rejects unsafe generated or repository-control patch paths', () => {
    const result = validateMakaAheChangeManifest({
      ...VALID_MAKA_AHE_CHANGE_MANIFEST,
      patch: {
        applyMode: 'staged_patch',
        changedFiles: ['packages/headless/dist/system-prompts.js', '../outside.ts', '.git/config'],
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.message.includes('generated')));
      assert(result.errors.some((error) => error.message.includes('traverse')));
      assert(result.errors.some((error) => error.message.includes('repository-control')));
    }
  });

  it('does not allow self-checks to claim official pass/fail', () => {
    const result = validateMakaAheRunResult({
      protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
      runId: 'run-candidate',
      snapshotId: 'snap-candidate',
      taskId: 'terminal-bench/sqlite-with-gcov',
      status: 'official_pass',
      scoreAuthority: 'self_check',
      score: 1,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.path === 'status'));
    }
  });

  it('requires TaskRun and lineage identity on versioned AHE run results', () => {
    const result = validateMakaAheRunResult({
      schemaVersion: MAKA_AHE_RUN_RESULT_SCHEMA_VERSION,
      protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
      runId: 'ahe-batch-run',
      snapshotId: 'snap-candidate',
      taskId: 'terminal-bench/sqlite-with-gcov',
      status: 'official_fail',
      scoreAuthority: 'official_verifier',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.path === 'taskRunId'));
      assert(result.errors.some((error) => error.path === 'executionLineageRef'));
    }
  });
});
