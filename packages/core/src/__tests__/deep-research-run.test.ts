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
import {
  projectDeepResearchEvents,
  type DeepResearchArtifactRecordedEvent,
  type DeepResearchChecklistUpdatedEvent,
  type DeepResearchCheckpointRecordedEvent,
  type DeepResearchCompletedEvent,
  type DeepResearchEvent,
  type DeepResearchReportSectionKey,
  type DeepResearchStartedEvent,
} from '../deep-research-run.js';

const SESSION_ID = 'session-1';
const HASH = `sha256:${'a'.repeat(64)}`;

function started(): DeepResearchStartedEvent {
  return {
    eventId: 'event-start',
    type: 'research_started',
    sessionId: SESSION_ID,
    ts: 1,
    objective: 'Explain the durable research workspace.',
    scopeLevel: 'standard',
  };
}

function artifact(
  artifactId: string,
  role: DeepResearchArtifactRecordedEvent['artifact']['role'],
  sourceArtifactIds: string[] = [],
  reportSectionKey?: DeepResearchReportSectionKey,
): DeepResearchArtifactRecordedEvent {
  return {
    eventId: `event-${artifactId}`,
    type: 'research_artifact_recorded',
    sessionId: SESSION_ID,
    ts: 2,
    artifact: {
      artifactId,
      role,
      name: `${artifactId}.md`,
      createdAt: 2,
      ...(role === 'source' ? { locator: 'https://example.com/source' } : {}),
      contentHash: HASH,
      sourceArtifactIds,
      ...(reportSectionKey ? { reportSectionKey, reportSectionStatus: 'completed' as const } : {}),
    },
  };
}

function checklist(
  itemId: string,
  evidenceArtifactIds: string[],
): DeepResearchChecklistUpdatedEvent {
  const titles: Record<string, string> = {
    project_entrypoints: 'Map project entrypoints and execution setup',
    core_flow: 'Trace the core implementation and data flow',
    boundaries: 'Verify permissions, privacy, failure, and runtime boundaries',
    verification_evidence: 'Collect tests, fixtures, and reproducible verification evidence',
  };
  return {
    eventId: `event-checklist-${itemId}`,
    type: 'research_checklist_updated',
    sessionId: SESSION_ID,
    ts: 8,
    item: {
      itemId,
      title: titles[itemId]!,
      status: 'completed',
      evidenceArtifactIds,
      updatedAt: 8,
    },
  };
}

function checkpoint(
  round: number,
  stage: DeepResearchCheckpointRecordedEvent['checkpoint']['stage'],
  artifactIds: string[],
): DeepResearchCheckpointRecordedEvent {
  return {
    eventId: `event-checkpoint-${round}-${stage}`,
    type: 'research_checkpoint_recorded',
    sessionId: SESSION_ID,
    ts: 3 + round,
    checkpoint: {
      checkpointId: `checkpoint-${round}-${stage}`,
      round,
      stage,
      status: 'active',
      summary: `Round ${round}`,
      openQuestions: [],
      nextSteps: ['Continue'],
      taskIds: [],
      artifactIds,
      createdAt: 3 + round,
    },
  };
}

function completed(reportArtifactId: string): DeepResearchCompletedEvent {
  return {
    eventId: 'event-complete',
    type: 'research_completed',
    sessionId: SESSION_ID,
    ts: 10,
    reportArtifactId,
    handoff: {
      artifactId: 'handoff-1',
      implementationTasks: ['Implement the workspace.'],
      recommendedIssues: ['Track UI progress.'],
      recommendedPullRequests: [],
      verificationCommands: ['npm test'],
    },
  };
}

describe('Deep Research run projection', () => {
  it('projects a source-grounded two-stage run through completion', () => {
    const events: DeepResearchEvent[] = [
      started(),
      artifact('source-1', 'source'),
      artifact('note-1', 'evidence_note', ['source-1']),
      checkpoint(1, 'knowledge_base', ['source-1', 'note-1']),
      artifact('outline-1', 'outline', ['source-1']),
      checkpoint(2, 'report_writing', ['source-1', 'note-1', 'outline-1']),
      artifact('section-conclusion', 'report_section', ['source-1'], 'conclusion'),
      artifact('section-evidence', 'report_section', ['source-1'], 'source_evidence'),
      artifact('section-tradeoffs', 'report_section', ['source-1'], 'borrow_diverge_risk_gate'),
      artifact(
        'section-implementation',
        'report_section',
        ['source-1'],
        'implementation_recommendations',
      ),
      artifact('section-verification', 'report_section', ['source-1'], 'verification'),
      artifact('report-1', 'report', ['source-1']),
      artifact('handoff-1', 'handoff', ['source-1']),
      checklist('project_entrypoints', ['source-1']),
      checklist('core_flow', ['note-1']),
      checklist('boundaries', ['source-1']),
      checklist('verification_evidence', ['source-1']),
      completed('report-1'),
    ];

    const projection = projectDeepResearchEvents(events);

    assert.deepEqual(projection.diagnostics, []);
    assert.equal(projection.run?.status, 'completed');
    assert.equal(projection.run?.scopeLevel, 'standard');
    assert.equal(projection.run?.stage, 'completed');
    assert.equal(projection.run?.round, 2);
    assert.equal(projection.run?.reportArtifactId, 'report-1');
    assert.equal(projection.run?.artifacts.length, 10);
    assert.equal(projection.run?.checkpoints.length, 2);
    assert.equal(projection.run?.handoff?.artifactId, 'handoff-1');
  });

  it('rejects derived evidence that does not cite an archived source', () => {
    const projection = projectDeepResearchEvents([
      started(),
      artifact('note-1', 'evidence_note', ['missing-source']),
    ]);

    assert.match(projection.diagnostics.join('\n'), /non-source artifact missing-source/);
    assert.equal(projection.run?.artifacts.length, 0);
  });

  it('rejects checkpoint round and stage regression', () => {
    const projection = projectDeepResearchEvents([
      started(),
      artifact('source-1', 'source'),
      checkpoint(2, 'report_writing', ['source-1']),
      checkpoint(1, 'knowledge_base', ['source-1']),
    ]);

    assert.match(projection.diagnostics.join('\n'), /round regressed/);
    assert.equal(projection.run?.round, 2);
    assert.equal(projection.run?.stage, 'report_writing');
  });

  it('does not complete without a saved final report artifact', () => {
    const missingReport = projectDeepResearchEvents([
      started(),
      artifact('source-1', 'source'),
      completed('missing-report'),
    ]);
    assert.match(missingReport.diagnostics.join('\n'), /missing report artifact/);
    assert.equal(missingReport.run?.status, 'active');
  });

  it('keeps completion gated on settled checklist items and report sections', () => {
    const base: DeepResearchEvent[] = [
      started(),
      artifact('source-1', 'source'),
      artifact('report-1', 'report', ['source-1']),
      artifact('handoff-1', 'handoff', ['source-1']),
    ];
    const checklistBlocked = projectDeepResearchEvents([...base, completed('report-1')]);
    assert.match(checklistBlocked.diagnostics.join('\n'), /checklist item project_entrypoints/);

    const sectionBlocked = projectDeepResearchEvents([
      ...base,
      checklist('project_entrypoints', ['source-1']),
      checklist('core_flow', ['source-1']),
      checklist('boundaries', ['source-1']),
      checklist('verification_evidence', ['source-1']),
      completed('report-1'),
    ]);
    assert.match(sectionBlocked.diagnostics.join('\n'), /report section conclusion/);
    assert.equal(sectionBlocked.run?.status, 'active');
  });
});
