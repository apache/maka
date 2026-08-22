/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeRuntimeEvent, type RuntimeEvent } from '../runtime-event.js';
import {
  buildWorkspaceBaselineAuthorityEvents,
  scanWorkspaceBaselineAuthority,
  validateWorkspaceFactEventLane,
  workspaceAuthorityIdentity,
  type WorkspaceBaselineAuthorityInput,
} from '../workspace-version-authority.js';

describe('workspace version authority contract', () => {
  it('decodes only exact v1 baseline facts on the store-owned semantic lane', () => {
    const { epochOpenedEvent, baselineAcceptedEvent } = buildWorkspaceBaselineAuthorityEvents(
      baselineInput(),
    );

    assert.deepEqual(decodeRuntimeEvent(epochOpenedEvent), epochOpenedEvent);
    assert.deepEqual(decodeRuntimeEvent(baselineAcceptedEvent), baselineAcceptedEvent);
    assert.deepEqual(validateWorkspaceFactEventLane(epochOpenedEvent), { ok: true });
    assert.deepEqual(validateWorkspaceFactEventLane(baselineAcceptedEvent), { ok: true });

    const invalidEvents: RuntimeEvent[] = [
      { ...epochOpenedEvent, partial: true },
      { ...epochOpenedEvent, branch: 'user-lane' },
      { ...epochOpenedEvent, content: { kind: 'text', text: 'not control-plane' } },
      { ...epochOpenedEvent, refs: { artifactId: 'artifact-1' } },
      {
        ...epochOpenedEvent,
        actions: { ...epochOpenedEvent.actions, stateDelta: { hidden: true } },
      },
    ];
    for (const event of invalidEvents) {
      assert.deepEqual(validateWorkspaceFactEventLane(event), {
        ok: false,
        code: 'semantic_lane_conflict',
        eventId: event.id,
      });
    }

    assert.throws(
      () =>
        decodeRuntimeEvent({
          ...epochOpenedEvent,
          actions: {
            workspaceFact: {
              ...epochOpenedEvent.actions!.workspaceFact!,
              version: 2,
            },
          },
        }),
      /Invalid RuntimeEvent schema/,
    );
    assert.throws(
      () =>
        decodeRuntimeEvent({
          ...baselineAcceptedEvent,
          actions: {
            workspaceFact: {
              ...baselineAcceptedEvent.actions!.workspaceFact!,
              extra: true,
            },
          },
        }),
      /Invalid RuntimeEvent schema/,
    );
    assert.throws(
      () =>
        decodeRuntimeEvent({
          ...epochOpenedEvent,
          actions: {
            workspaceFact: {
              ...epochOpenedEvent.actions!.workspaceFact!,
              payload: {
                ...epochOpenedEvent.actions!.workspaceFact!.payload,
                objectFormat: 'sha256',
              },
            },
          },
        }),
      /Invalid RuntimeEvent schema/,
    );
    assert.throws(
      () =>
        decodeRuntimeEvent({
          ...baselineAcceptedEvent,
          actions: {
            workspaceFact: {
              ...baselineAcceptedEvent.actions!.workspaceFact!,
              payload: {
                ...baselineAcceptedEvent.actions!.workspaceFact!.payload,
                changedFileCount: -1,
              },
            },
          },
        }),
      /Invalid RuntimeEvent schema/,
    );
    assert.throws(
      () =>
        decodeRuntimeEvent({
          ...baselineAcceptedEvent,
          actions: {
            workspaceFact: {
              ...baselineAcceptedEvent.actions!.workspaceFact!,
              payload: {
                ...baselineAcceptedEvent.actions!.workspaceFact!.payload,
                unexpected: true,
              },
            },
          },
        }),
      /Invalid RuntimeEvent schema/,
    );
  });

  it('derives an isolated deterministic authority spine for each epoch', () => {
    const identity = workspaceAuthorityIdentity('epoch_33333333333333333333333333333333');
    assert.deepEqual(identity, {
      sessionId: 'maka_workspace_authority',
      invocationId: 'workspace_inv_33333333333333333333333333333333',
      runId: 'workspace_run_33333333333333333333333333333333',
      turnId: 'workspace_turn_33333333333333333333333333333333',
    });
  });

  it('reconstructs only complete, causal baseline pairs', () => {
    const first = buildWorkspaceBaselineAuthorityEvents(baselineInput());
    const second = buildWorkspaceBaselineAuthorityEvents(
      baselineInput({
        epochOpenedEventId: 'workspace-epoch-event-2',
        baselineAcceptedEventId: 'workspace-version-event-2',
        epoch: {
          ...baselineInput().epoch,
          workspaceEpochId: 'epoch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          workspaceInstanceId: 'instance_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        baseline: {
          ...baselineInput().baseline,
          workspaceVersionId: 'version_cccccccccccccccccccccccccccccccc',
        },
      }),
    );

    const scan = scanWorkspaceBaselineAuthority([
      { event: second.baselineAcceptedEvent, eventSeq: 2 },
      { event: first.epochOpenedEvent, eventSeq: 1 },
      { event: second.epochOpenedEvent, eventSeq: 1 },
      { event: first.baselineAcceptedEvent, eventSeq: 2 },
    ]);
    assert.equal(scan.hasCorruption, false);
    assert.deepEqual(scan.baselines.map((baseline) => baseline.epoch.workspaceEpochId).sort(), [
      'epoch_33333333333333333333333333333333',
      'epoch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);

    const outOfOrder = scanWorkspaceBaselineAuthority([
      { event: first.epochOpenedEvent, eventSeq: 2 },
      { event: first.baselineAcceptedEvent, eventSeq: 1 },
    ]);
    assert.deepEqual(outOfOrder.issues, [
      {
        code: 'event_order_conflict',
        eventId: first.baselineAcceptedEvent.id,
        workspaceEpochId: first.epochOpenedEvent.actions!.workspaceFact!.payload.workspaceEpochId,
      },
    ]);

    const orphan = scanWorkspaceBaselineAuthority([
      { event: first.baselineAcceptedEvent, eventSeq: 2 },
    ]);
    assert.equal(orphan.hasCorruption, true);
    assert.equal(orphan.issues[0]?.code, 'orphan_baseline_version');
  });
});

function baselineInput(
  overrides: Partial<WorkspaceBaselineAuthorityInput> = {},
): WorkspaceBaselineAuthorityInput {
  const base: WorkspaceBaselineAuthorityInput = {
    epochOpenedEventId: 'workspace-epoch-event-1',
    baselineAcceptedEventId: 'workspace-version-event-1',
    committedAt: 1_700_000_000_000,
    epoch: {
      repositoryId: 'repository_11111111111111111111111111111111',
      workspaceId: 'workspace_22222222222222222222222222222222',
      workspaceEpochId: 'epoch_33333333333333333333333333333333',
      workspaceInstanceId: 'instance_44444444444444444444444444444444',
      mode: 'managed_worktree',
      objectFormat: 'sha1',
      sourceCommitOid: '1'.repeat(40),
      sourceTreeOid: '2'.repeat(40),
      materializationProfileDigest: `sha256:${'3'.repeat(64)}`,
      materializationSemantics: 'git_tree_materialized_with_fixed_config_v1',
      policyHash: `sha256:${'4'.repeat(64)}`,
    },
    baseline: {
      workspaceVersionId: 'version_55555555555555555555555555555555',
      commitOid: '5'.repeat(40),
      treeOid: '2'.repeat(40),
      treeDeltaDigest: `sha256:${'6'.repeat(64)}`,
      changedFileCount: 7,
      deletedFileCount: 0,
    },
  };
  return {
    ...base,
    ...overrides,
    epoch: overrides.epoch ?? base.epoch,
    baseline: overrides.baseline ?? base.baseline,
  };
}
