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
import { test } from 'node:test';
import {
  DEEP_RESEARCH_DEFAULT_CHECKLIST,
  DEEP_RESEARCH_REPORT_SECTION_KEYS,
  projectDeepResearchEvents,
  type DeepResearchArtifactRef,
  type DeepResearchEvent,
} from '@maka/core/deep-research-run';
import {
  decodeDeepResearchQueryResult,
  decodeRequestFrame,
  decodeResponseFrame,
  DEEP_RESEARCH_RECENT_REFS_MAX,
  DEEP_RESEARCH_RESULT_MAX_BYTES,
  HOST_OPERATION_SPECS,
} from '../protocol/index.js';
import { projectDeepResearchRun } from '../server/deep-research-coordinator.js';

const snapshot = {
  kind: 'snapshot' as const,
  sessionId: 'session-1',
  revision: 3,
  objective: 'Trace the Runtime Host boundary',
  scopeLevel: 'standard' as const,
  status: 'active' as const,
  stage: 'knowledge_base' as const,
  round: 1,
  createdAt: 1,
  updatedAt: 2,
  artifactsCount: 2,
  stepsCount: 1,
  checklist: [
    {
      itemId: 'core_flow',
      title: 'Trace the core implementation and data flow',
      status: 'in_progress' as const,
      blockedReason: null,
    },
  ],
  reportSections: [{ key: 'conclusion' as const, status: 'pending' as const }],
  recentInspectedRefs: [{ kind: 'file' as const, locator: 'src/main.ts', label: null }],
  workerRunIds: ['worker.run:1'],
  blockers: [],
  reportArtifactId: null,
  implementationPrompt: null,
};

test('Deep Research protocol exposes one bounded read-only projection', () => {
  assert.equal(HOST_OPERATION_SPECS['deep-research.query'].mode, 'query');
  assert.deepEqual(
    decodeRequestFrame({
      requestId: 'request-1',
      operation: 'deep-research.query',
      input: { sessionId: 'session-1' },
    }),
    {
      requestId: 'request-1',
      operation: 'deep-research.query',
      input: { sessionId: 'session-1' },
    },
  );
  assert.deepEqual(
    decodeResponseFrame({
      requestId: 'request-1',
      operation: 'deep-research.query',
      ok: true,
      result: snapshot,
    }),
    {
      requestId: 'request-1',
      operation: 'deep-research.query',
      ok: true,
      result: snapshot,
    },
  );
});

test('Deep Research projection rejects open, oversized, and cross-Session shapes', () => {
  assert.deepEqual(decodeDeepResearchQueryResult(snapshot), snapshot);
  assert.throws(() => decodeDeepResearchQueryResult({ ...snapshot, extra: true }));
  assert.throws(() =>
    decodeDeepResearchQueryResult({
      ...snapshot,
      recentInspectedRefs: Array.from({ length: DEEP_RESEARCH_RECENT_REFS_MAX + 1 }, () => ({
        kind: 'file',
        locator: 'src/main.ts',
        label: null,
      })),
    }),
  );
  assert.throws(() =>
    HOST_OPERATION_SPECS['deep-research.query'].assertOutputForInput?.(
      { sessionId: 'session-1' },
      { ...snapshot, sessionId: 'session-2' },
    ),
  );
  assert.throws(() =>
    decodeDeepResearchQueryResult({ kind: 'not_started', sessionId: 'session-1', revision: 1 }),
  );
});

test('Deep Research producer fits escaping-heavy legal state to its encoded result budget', () => {
  const projectionResult = projectDeepResearchEvents(escapingHeavyCompletedEvents());
  assert.deepEqual(projectionResult.diagnostics, []);
  assert.ok(projectionResult.run);
  assert.equal(projectionResult.run.status, 'completed');

  const projection = projectDeepResearchRun(projectionResult.run, 7);
  assert.deepEqual(decodeDeepResearchQueryResult(projection), projection);
  assert.ok(
    Buffer.byteLength(JSON.stringify(projection), 'utf8') <= DEEP_RESEARCH_RESULT_MAX_BYTES,
  );
});

function escapingHeavyCompletedEvents(): DeepResearchEvent[] {
  const escaped = '\u0000"\\';
  const sessionId = 'session-research';
  let eventIndex = 0;
  let timestamp = 0;
  const event = <T extends Omit<DeepResearchEvent, 'eventId' | 'sessionId' | 'ts'>>(
    value: T,
  ): T & Pick<DeepResearchEvent, 'eventId' | 'sessionId' | 'ts'> => ({
    ...value,
    eventId: `event-${++eventIndex}`,
    sessionId,
    ts: ++timestamp,
  });
  const artifact = (
    value: Omit<DeepResearchArtifactRef, 'createdAt' | 'contentHash'>,
  ): DeepResearchArtifactRef => ({
    ...value,
    createdAt: timestamp + 1,
    contentHash: `sha256:${'a'.repeat(64)}`,
  });
  const sourceArtifact = artifact({
    artifactId: 'source-1',
    role: 'source',
    name: 'source.md',
    locator: 'https://example.com/source',
    sourceArtifactIds: [],
  });
  const evidenceArtifact = artifact({
    artifactId: 'evidence-1',
    role: 'evidence_note',
    name: 'evidence.md',
    sourceArtifactIds: [sourceArtifact.artifactId],
  });
  const reportSectionArtifacts = DEEP_RESEARCH_REPORT_SECTION_KEYS.map((key) =>
    artifact({
      artifactId: `section-${key}`,
      role: 'report_section',
      name: `${key}.md`,
      sourceArtifactIds: [sourceArtifact.artifactId],
      reportSectionKey: key,
      reportSectionStatus: 'completed',
    }),
  );
  const reportArtifact = artifact({
    artifactId: 'report-1',
    role: 'report',
    name: 'report.md',
    sourceArtifactIds: [sourceArtifact.artifactId],
  });
  const handoffArtifact = artifact({
    artifactId: 'handoff-1',
    role: 'handoff',
    name: 'handoff.md',
    sourceArtifactIds: [sourceArtifact.artifactId],
  });
  const artifacts = [
    sourceArtifact,
    evidenceArtifact,
    ...reportSectionArtifacts,
    reportArtifact,
    handoffArtifact,
  ];

  return [
    event({
      type: 'research_started',
      objective: 'Inspect the Runtime Host boundary',
      scopeLevel: 'deep',
    }),
    ...artifacts.map((entry) => event({ type: 'research_artifact_recorded', artifact: entry })),
    ...DEEP_RESEARCH_DEFAULT_CHECKLIST.map((item) =>
      event({
        type: 'research_checklist_updated',
        item: {
          ...item,
          status: 'completed' as const,
          evidenceArtifactIds: [evidenceArtifact.artifactId],
          updatedAt: timestamp + 1,
        },
      }),
    ),
    event({
      type: 'research_step_recorded',
      step: {
        stepId: 'step-1',
        kind: 'local_exploration',
        status: 'completed',
        objective: 'Inspect the boundary',
        summary: 'Boundary inspected',
        roots: ['.'],
        keywords: [],
        ignoredPaths: [],
        stoppingCondition: 'Enough evidence',
        expectedEvidence: 'Source references',
        evidenceArtifactIds: [evidenceArtifact.artifactId],
        inspectedRefs: Array.from({ length: DEEP_RESEARCH_RECENT_REFS_MAX }, (_, index) => ({
          kind: 'file',
          locator: escaped.repeat(1_365),
          label: `${index}-${escaped.repeat(330)}`,
          sourceArtifactId: sourceArtifact.artifactId,
        })),
        workerRunIds: Array.from(
          { length: DEEP_RESEARCH_RECENT_REFS_MAX },
          (_, index) => `worker.run:${index}`,
        ),
        createdAt: timestamp + 1,
      },
    }),
    event({
      type: 'research_checkpoint_recorded',
      checkpoint: {
        checkpointId: 'checkpoint-1',
        round: 1,
        stage: 'report_writing',
        status: 'active',
        summary: 'Report sections completed',
        openQuestions: [],
        nextSteps: ['Complete the research run'],
        taskIds: [],
        artifactIds: [reportArtifact.artifactId, handoffArtifact.artifactId],
        createdAt: timestamp + 1,
      },
    }),
    event({
      type: 'research_completed',
      reportArtifactId: reportArtifact.artifactId,
      handoff: {
        artifactId: handoffArtifact.artifactId,
        implementationTasks: Array.from({ length: 50 }, () => escaped.repeat(333)),
        recommendedIssues: ['issue-1'],
        recommendedPullRequests: [],
        verificationCommands: ['npm test'],
      },
    }),
  ];
}
