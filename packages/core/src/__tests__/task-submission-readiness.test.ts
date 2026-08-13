import { describe, test } from 'node:test';
import type { LlmConnection } from '../llm-connections.js';
import {
  deriveTaskSubmissionReadiness,
  type DeriveTaskSubmissionReadinessInput,
} from '../task-submission-readiness.js';
import { expect } from '../test-helpers.js';

describe('task submission readiness', () => {
  test('reuses connection readiness and routes an invalid model to its connection', () => {
    const input = readyInput();
    if (input.modelTarget.kind !== 'resolved') throw new Error('expected resolved model target');
    input.modelTarget.requestedModel = 'removed-model';
    const snapshot = deriveTaskSubmissionReadiness(input);

    expect(snapshot.state).toBe('repair_required');
    expect(snapshot.blockers[0]).toEqual({
      id: 'model_target',
      state: 'repair_required',
      authority: 'connection_readiness',
      checkedAt: 90,
      blockerCode: 'model_model_not_enabled',
      repairTarget: { kind: 'connection', connectionSlug: 'provider' },
    });
  });

  test('does not turn unresolved credentials into a confirmed repair failure', () => {
    const input = readyInput();
    if (input.modelTarget.kind !== 'resolved') throw new Error('expected resolved model target');
    input.modelTarget.hasSecret = undefined;
    const snapshot = deriveTaskSubmissionReadiness(input);

    expect(snapshot.state).toBe('unknown');
    expect(snapshot.blockers[0]?.blockerCode).toBe('model_credentials_unknown');
    expect(snapshot.blockers[0]?.repairTarget).toBe(undefined);
  });

  test('distinguishes unavailable runtime and workspace from repairable setup', () => {
    const runtimeInput = readyInput();
    runtimeInput.runtime.state = 'unavailable';
    expect(deriveTaskSubmissionReadiness(runtimeInput).state).toBe('unavailable');

    const workspaceInput = readyInput();
    workspaceInput.workspace.state = 'missing';
    const workspace = deriveTaskSubmissionReadiness(workspaceInput);
    expect(workspace.state).toBe('repair_required');
    expect(workspace.blockers[0]?.repairTarget).toEqual({ kind: 'workspace_picker' });
  });

  test('only requested capabilities participate in submission readiness', () => {
    const input = readyInput();
    input.capabilities = [
      { id: 'computer_use', state: 'unavailable', checkedAt: 80 },
      { id: 'git', state: 'ready', checkedAt: 81 },
    ];

    const ordinaryTask = deriveTaskSubmissionReadiness(input);
    expect(ordinaryTask.state).toBe('ready');
    expect(ordinaryTask.dimensions).toHaveLength(3);

    input.requestedCapabilityIds = ['computer_use'];
    const computerUseTask = deriveTaskSubmissionReadiness(input);
    expect(computerUseTask.state).toBe('unavailable');
    expect(computerUseTask.blockers[0]?.id).toBe('capability:computer_use');
  });

  test('treats a missing requested capability observation as unknown', () => {
    const input = readyInput();
    input.requestedCapabilityIds = ['git'];
    const snapshot = deriveTaskSubmissionReadiness(input);

    expect(snapshot.state).toBe('unknown');
    expect(snapshot.blockers[0]?.blockerCode).toBe('capability_unknown');
    expect(snapshot.blockers[0]?.repairTarget).toBe(undefined);
  });
});

function readyInput(): DeriveTaskSubmissionReadinessInput {
  return {
    checkedAt: 100,
    runtime: { state: 'ready', checkedAt: 95 },
    modelTarget: {
      kind: 'resolved',
      connection: connection(),
      hasSecret: true,
      requestedModel: 'model-a',
      checkedAt: 90,
    },
    workspace: { state: 'ready', checkedAt: 85 },
  };
}

function connection(): LlmConnection {
  return {
    slug: 'provider',
    name: 'Provider',
    providerType: 'openai-compatible',
    enabled: true,
    defaultModel: 'model-a',
    enabledModelIds: ['model-a'],
    models: [{ id: 'model-a' }],
    createdAt: 1,
    updatedAt: 1,
  };
}
