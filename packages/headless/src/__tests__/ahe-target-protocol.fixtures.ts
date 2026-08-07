import {
  MAKA_AHE_TARGET_PROTOCOL_VERSION,
  MAKA_AHE_TARGET_SOURCE_LABEL,
  type MakaAheChangeManifest,
} from '../ahe-target-protocol.js';

export const VALID_MAKA_AHE_CHANGE_MANIFEST: MakaAheChangeManifest = {
  protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
  manifestId: 'manifest-ahe-target-001',
  sourceLabel: MAKA_AHE_TARGET_SOURCE_LABEL,
  targetSnapshotId: 'snap-baseline',
  createdAt: '2026-07-01T00:00:00.000Z',
  changedComponents: ['maka-tool-contracts'],
  editedSurface: 'tool_contract',
  evidenceRefs: [
    {
      taskId: 'terminal-bench/sqlite-with-gcov',
      runId: 'run-baseline',
      resultStatus: 'official_fail',
      summary: 'Official verifier failed after the trace showed a missing gcov artifact.',
    },
  ],
  hypothesis:
    'Tool contract omitted the expected artifact path, so the task plan never verified coverage output.',
  targetedFix: 'Clarify the artifact contract in the tool description and prompt policy.',
  predictedFixes: [
    {
      taskId: 'terminal-bench/sqlite-with-gcov',
      summary: 'Candidate should create the gcov artifact before finalizing.',
    },
  ],
  riskTasks: [
    {
      taskId: 'terminal-bench/qemu-startup',
      summary: 'Prompt/tool changes must not add extra setup work to unrelated heavy tasks.',
    },
  ],
  validationDataset: {
    datasetId: 'terminal-bench-smoke-heavy',
    taskIds: ['terminal-bench/sqlite-with-gcov', 'terminal-bench/qemu-startup'],
    baselineRunId: 'run-baseline',
  },
  patch: {
    applyMode: 'staged_patch',
    changedFiles: ['packages/runtime/src/tool-runtime.ts'],
  },
  rollbackCriteria: ['Any pass_to_fail official transition in the validation dataset.'],
};

export const INVALID_MAKA_AHE_COMPONENTS = [
  {
    id: 'maka-system-prompt',
    category: 'unknown',
    label: 'duplicate one',
    description: 'bad category',
    editable: true,
    sourceRefs: [{ path: 'packages/runtime-host/src/server/execution-model-composition.ts' }],
  },
  {
    id: 'maka-system-prompt',
    category: 'system_prompt',
    label: 'duplicate two',
    description: 'duplicate id',
    editable: true,
    sourceRefs: [],
  },
] as const;

export const INVALID_MAKA_AHE_CHANGE_MANIFEST = {
  ...VALID_MAKA_AHE_CHANGE_MANIFEST,
  changedComponents: ['not-a-component'],
  predictedFixes: [],
  rollbackCriteria: [],
} as const;
