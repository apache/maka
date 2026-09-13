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

/**
 * Durable Deep Research workspace contract.
 *
 * This independently reproduces the central systems idea from FS-Researcher
 * (Zhu et al., ACL 2026): evidence collection and report writing share a
 * persistent workspace that survives model-context and process boundaries.
 * Maka keeps the canonical state as an append-only event ledger and stores
 * large source/note/report bodies in the existing ArtifactStore.
 *
 * Paper: https://arxiv.org/abs/2602.01566
 */

import { isFiniteNumber, isRecord } from './record-schema.js';
import { redactSecrets } from './redaction.js';

export const DEEP_RESEARCH_RUN_SCHEMA_VERSION = 1 as const;

export const DEEP_RESEARCH_ACTIVE_STAGES = ['knowledge_base', 'report_writing'] as const;
export type DeepResearchActiveStage = (typeof DEEP_RESEARCH_ACTIVE_STAGES)[number];

export const DEEP_RESEARCH_STAGES = [...DEEP_RESEARCH_ACTIVE_STAGES, 'completed'] as const;
export type DeepResearchStage = (typeof DEEP_RESEARCH_STAGES)[number];

export const DEEP_RESEARCH_RUN_STATUSES = ['active', 'blocked', 'completed'] as const;
export type DeepResearchRunStatus = (typeof DEEP_RESEARCH_RUN_STATUSES)[number];

export const DEEP_RESEARCH_SCOPE_LEVELS = ['quick', 'standard', 'deep'] as const;
export type DeepResearchScopeLevel = (typeof DEEP_RESEARCH_SCOPE_LEVELS)[number];

export const DEEP_RESEARCH_ARTIFACT_ROLES = [
  'source',
  'evidence_note',
  'outline',
  'report_section',
  'report',
  'handoff',
] as const;
export type DeepResearchArtifactRole = (typeof DEEP_RESEARCH_ARTIFACT_ROLES)[number];

export const DEEP_RESEARCH_CHECKLIST_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'skipped',
] as const;
export type DeepResearchChecklistStatus = (typeof DEEP_RESEARCH_CHECKLIST_STATUSES)[number];

export const DEEP_RESEARCH_REPORT_SECTION_KEYS = [
  'conclusion',
  'source_evidence',
  'borrow_diverge_risk_gate',
  'implementation_recommendations',
  'verification',
] as const;
export type DeepResearchReportSectionKey = (typeof DEEP_RESEARCH_REPORT_SECTION_KEYS)[number];

export const DEEP_RESEARCH_REPORT_SECTION_STATUSES = ['pending', 'drafted', 'completed'] as const;
export type DeepResearchReportSectionStatus =
  (typeof DEEP_RESEARCH_REPORT_SECTION_STATUSES)[number];

export const DEEP_RESEARCH_STEP_KINDS = ['local_exploration', 'web_research'] as const;
export type DeepResearchStepKind = (typeof DEEP_RESEARCH_STEP_KINDS)[number];

export const DEEP_RESEARCH_STEP_STATUSES = ['completed', 'blocked', 'stopped'] as const;
export type DeepResearchStepStatus = (typeof DEEP_RESEARCH_STEP_STATUSES)[number];

export const DEEP_RESEARCH_INSPECTED_REF_KINDS = [
  'file',
  'symbol',
  'config',
  'test',
  'runtime',
  'url',
] as const;
export type DeepResearchInspectedRefKind = (typeof DEEP_RESEARCH_INSPECTED_REF_KINDS)[number];

export const DEEP_RESEARCH_EVENT_TYPES = [
  'research_started',
  'research_artifact_recorded',
  'research_checklist_updated',
  'research_step_recorded',
  'research_checkpoint_recorded',
  'research_completed',
] as const;
export type DeepResearchEventType = (typeof DEEP_RESEARCH_EVENT_TYPES)[number];

export const DEEP_RESEARCH_OBJECTIVE_MAX_CHARS = 2_000;
export const DEEP_RESEARCH_ARTIFACT_NAME_MAX_CHARS = 240;
export const DEEP_RESEARCH_LOCATOR_MAX_CHARS = 4_096;
export const DEEP_RESEARCH_CHECKPOINT_TEXT_MAX_CHARS = 4_000;
export const DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS = 1_000;
export const DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX = 50;
export const DEEP_RESEARCH_REFS_MAX = 100;
export const DEEP_RESEARCH_ARTIFACTS_MAX = 2_000;
export const DEEP_RESEARCH_CHECKPOINTS_MAX = 500;
export const DEEP_RESEARCH_CHECKLIST_ITEMS_MAX = 50;
export const DEEP_RESEARCH_STEPS_MAX = 500;
export const DEEP_RESEARCH_STEP_TEXT_MAX_CHARS = 2_000;
export const DEEP_RESEARCH_STEP_LIST_ITEMS_MAX = 50;
export const DEEP_RESEARCH_INSPECTED_REFS_MAX = 200;
export const DEEP_RESEARCH_CLIENT_PROGRESS_MAX_BYTES = 46 * 1024;
export const DEEP_RESEARCH_CLIENT_RECENT_ITEMS_MAX = 8;
export const DEEP_RESEARCH_CLIENT_OBJECTIVE_MAX_BYTES = 4 * 1024;
export const DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES = 256;
export const DEEP_RESEARCH_CLIENT_IMPLEMENTATION_PROMPT_MAX_BYTES = 16 * 1024;

export const DEEP_RESEARCH_DEFAULT_CHECKLIST = [
  { itemId: 'project_entrypoints', title: 'Map project entrypoints and execution setup' },
  { itemId: 'core_flow', title: 'Trace the core implementation and data flow' },
  { itemId: 'boundaries', title: 'Verify permissions, privacy, failure, and runtime boundaries' },
  {
    itemId: 'verification_evidence',
    title: 'Collect tests, fixtures, and reproducible verification evidence',
  },
] as const;

export interface DeepResearchEventRefs {
  runId?: string;
  turnId?: string;
  toolCallId?: string;
}

export interface DeepResearchArtifactRef {
  artifactId: string;
  role: DeepResearchArtifactRole;
  name: string;
  /** Exact caller-provided summary used for semantic retry validation. */
  summary?: string;
  createdAt: number;
  /** URL, repository path, file path, or another human-inspectable source locator. */
  locator?: string;
  /** sha256:<lowercase hex>, computed from the exact persisted artifact body. */
  contentHash: string;
  /** Direct source artifacts supporting this derived note/report artifact. */
  sourceArtifactIds: string[];
  reportSectionKey?: DeepResearchReportSectionKey;
  reportSectionStatus?: Exclude<DeepResearchReportSectionStatus, 'pending'>;
}

export interface DeepResearchChecklistItem {
  itemId: string;
  title: string;
  status: DeepResearchChecklistStatus;
  evidenceArtifactIds: string[];
  blockedReason?: string;
  updatedAt: number;
}

export interface DeepResearchReportSectionState {
  key: DeepResearchReportSectionKey;
  status: DeepResearchReportSectionStatus;
  artifactId?: string;
  updatedAt: number;
}

export interface DeepResearchInspectedRef {
  kind: DeepResearchInspectedRefKind;
  locator: string;
  label?: string;
  sourceArtifactId?: string;
}

export interface DeepResearchStep {
  stepId: string;
  kind: DeepResearchStepKind;
  status: DeepResearchStepStatus;
  objective: string;
  summary: string;
  roots: string[];
  keywords: string[];
  ignoredPaths: string[];
  stoppingCondition: string;
  expectedEvidence: string;
  evidenceArtifactIds: string[];
  inspectedRefs: DeepResearchInspectedRef[];
  workerRunIds: string[];
  blockedReason?: string;
  createdAt: number;
}

export interface DeepResearchHandoff {
  artifactId: string;
  implementationTasks: string[];
  recommendedIssues: string[];
  recommendedPullRequests: string[];
  verificationCommands: string[];
}

export interface DeepResearchCheckpoint {
  checkpointId: string;
  round: number;
  stage: DeepResearchActiveStage;
  status: Exclude<DeepResearchRunStatus, 'completed'>;
  summary: string;
  openQuestions: string[];
  nextSteps: string[];
  /** Existing Task Ledger ids/keys; the research ledger links rather than duplicates tasks. */
  taskIds: string[];
  /** Existing research artifact ids needed to resume this checkpoint. */
  artifactIds: string[];
  createdAt: number;
}

interface DeepResearchEventBase {
  eventId: string;
  type: DeepResearchEventType;
  sessionId: string;
  ts: number;
  refs?: DeepResearchEventRefs;
}

export interface DeepResearchStartedEvent extends DeepResearchEventBase {
  type: 'research_started';
  objective: string;
  scopeLevel: DeepResearchScopeLevel;
}

export interface DeepResearchArtifactRecordedEvent extends DeepResearchEventBase {
  type: 'research_artifact_recorded';
  artifact: DeepResearchArtifactRef;
}

export interface DeepResearchChecklistUpdatedEvent extends DeepResearchEventBase {
  type: 'research_checklist_updated';
  item: DeepResearchChecklistItem;
}

export interface DeepResearchStepRecordedEvent extends DeepResearchEventBase {
  type: 'research_step_recorded';
  step: DeepResearchStep;
}

export interface DeepResearchCheckpointRecordedEvent extends DeepResearchEventBase {
  type: 'research_checkpoint_recorded';
  checkpoint: DeepResearchCheckpoint;
}

export interface DeepResearchCompletedEvent extends DeepResearchEventBase {
  type: 'research_completed';
  reportArtifactId: string;
  handoff: DeepResearchHandoff;
}

export type DeepResearchEvent =
  | DeepResearchStartedEvent
  | DeepResearchArtifactRecordedEvent
  | DeepResearchChecklistUpdatedEvent
  | DeepResearchStepRecordedEvent
  | DeepResearchCheckpointRecordedEvent
  | DeepResearchCompletedEvent;

export interface DeepResearchRun {
  schemaVersion: typeof DEEP_RESEARCH_RUN_SCHEMA_VERSION;
  sessionId: string;
  objective: string;
  scopeLevel: DeepResearchScopeLevel;
  status: DeepResearchRunStatus;
  stage: DeepResearchStage;
  round: number;
  createdAt: number;
  updatedAt: number;
  artifacts: DeepResearchArtifactRef[];
  checklist: DeepResearchChecklistItem[];
  steps: DeepResearchStep[];
  reportSections: DeepResearchReportSectionState[];
  checkpoints: DeepResearchCheckpoint[];
  reportArtifactId?: string;
  handoff?: DeepResearchHandoff;
  completedAt?: number;
}

/** Bounded product-facing progress shared by local and Host-backed clients. */
export interface DeepResearchClientProgress {
  sessionId: string;
  objective: string;
  scopeLevel: DeepResearchScopeLevel;
  status: DeepResearchRunStatus;
  stage: DeepResearchStage;
  round: number;
  createdAt: number;
  updatedAt: number;
  artifactsCount: number;
  stepsCount: number;
  checklist: Array<
    Pick<DeepResearchChecklistItem, 'itemId' | 'title' | 'status' | 'blockedReason'>
  >;
  reportSections: Array<Pick<DeepResearchReportSectionState, 'key' | 'status'>>;
  recentInspectedRefs: Array<Pick<DeepResearchInspectedRef, 'kind' | 'locator' | 'label'>>;
  workerRunIds: string[];
  blockers: string[];
  reportArtifactId?: string;
  implementationPrompt?: string;
}

export interface DeepResearchProjection {
  run?: DeepResearchRun;
  diagnostics: string[];
}

export interface DeepResearchMutationContext {
  runId?: string;
  turnId?: string;
  toolCallId?: string;
}

export interface DeepResearchChangedEvent {
  sessionId: string;
  ts: number;
}

export interface DeepResearchStore {
  read(sessionId: string): Promise<DeepResearchRun | undefined>;
  readEvents(sessionId: string): Promise<DeepResearchEvent[]>;
  start(
    sessionId: string,
    objective: string,
    scopeLevel: DeepResearchScopeLevel,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  recordArtifact(
    sessionId: string,
    artifact: DeepResearchArtifactRef,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  updateChecklist(
    sessionId: string,
    item: Omit<DeepResearchChecklistItem, 'title' | 'updatedAt'>,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  recordStep(
    sessionId: string,
    step: Omit<DeepResearchStep, 'stepId' | 'createdAt'>,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  recordCheckpoint(
    sessionId: string,
    checkpoint: Omit<DeepResearchCheckpoint, 'checkpointId' | 'createdAt'>,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  complete(
    sessionId: string,
    reportArtifactId: string,
    handoff: DeepResearchHandoff,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  subscribe(listener: (event: DeepResearchChangedEvent) => void): () => void;
}

export function isDeepResearchActiveStage(value: unknown): value is DeepResearchActiveStage {
  return (
    typeof value === 'string' && (DEEP_RESEARCH_ACTIVE_STAGES as readonly string[]).includes(value)
  );
}

export function isDeepResearchArtifactRole(value: unknown): value is DeepResearchArtifactRole {
  return (
    typeof value === 'string' && (DEEP_RESEARCH_ARTIFACT_ROLES as readonly string[]).includes(value)
  );
}

export function isDeepResearchScopeLevel(value: unknown): value is DeepResearchScopeLevel {
  return (
    typeof value === 'string' && (DEEP_RESEARCH_SCOPE_LEVELS as readonly string[]).includes(value)
  );
}

export function isDeepResearchChecklistStatus(
  value: unknown,
): value is DeepResearchChecklistStatus {
  return (
    typeof value === 'string' &&
    (DEEP_RESEARCH_CHECKLIST_STATUSES as readonly string[]).includes(value)
  );
}

export function isDeepResearchReportSectionKey(
  value: unknown,
): value is DeepResearchReportSectionKey {
  return (
    typeof value === 'string' &&
    (DEEP_RESEARCH_REPORT_SECTION_KEYS as readonly string[]).includes(value)
  );
}

export function isDeepResearchReportSectionStatus(
  value: unknown,
): value is DeepResearchReportSectionStatus {
  return (
    typeof value === 'string' &&
    (DEEP_RESEARCH_REPORT_SECTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isDeepResearchStepKind(value: unknown): value is DeepResearchStepKind {
  return (
    typeof value === 'string' && (DEEP_RESEARCH_STEP_KINDS as readonly string[]).includes(value)
  );
}

export function isDeepResearchStepStatus(value: unknown): value is DeepResearchStepStatus {
  return (
    typeof value === 'string' && (DEEP_RESEARCH_STEP_STATUSES as readonly string[]).includes(value)
  );
}

export function normalizeDeepResearchObjective(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (
    normalized.length === 0 ||
    Array.from(normalized).length > DEEP_RESEARCH_OBJECTIVE_MAX_CHARS
  ) {
    return undefined;
  }
  return normalized;
}

export function isDeepResearchEvent(value: unknown): value is DeepResearchEvent {
  if (
    !isRecord(value) ||
    !isStableId(value.eventId) ||
    !(DEEP_RESEARCH_EVENT_TYPES as readonly unknown[]).includes(value.type) ||
    !isStableId(value.sessionId) ||
    !isFiniteNumber(value.ts) ||
    !isEventRefs(value.refs)
  ) {
    return false;
  }
  switch (value.type) {
    case 'research_started':
      return (
        normalizeDeepResearchObjective(value.objective) === value.objective &&
        isDeepResearchScopeLevel(value.scopeLevel)
      );
    case 'research_artifact_recorded':
      return isDeepResearchArtifactRef(value.artifact);
    case 'research_checklist_updated':
      return isDeepResearchChecklistItem(value.item);
    case 'research_step_recorded':
      return isDeepResearchStep(value.step);
    case 'research_checkpoint_recorded':
      return isDeepResearchCheckpoint(value.checkpoint);
    case 'research_completed':
      return isStableId(value.reportArtifactId) && isDeepResearchHandoff(value.handoff);
    default:
      return false;
  }
}

export function projectDeepResearchEvents(
  events: readonly DeepResearchEvent[],
): DeepResearchProjection {
  let run: DeepResearchRun | undefined;
  const diagnostics: string[] = [];
  const eventIds = new Set<string>();
  const artifactIds = new Set<string>();
  const checkpointIds = new Set<string>();
  const stepIds = new Set<string>();

  for (const event of events) {
    if (!isDeepResearchEvent(event)) {
      diagnostics.push('invalid deep research event shape');
      continue;
    }
    if (eventIds.has(event.eventId)) {
      diagnostics.push(`duplicate deep research event id ${event.eventId}`);
      continue;
    }
    eventIds.add(event.eventId);

    if (event.type === 'research_started') {
      if (run) {
        diagnostics.push(`duplicate research_started for session ${event.sessionId}`);
        continue;
      }
      run = {
        schemaVersion: DEEP_RESEARCH_RUN_SCHEMA_VERSION,
        sessionId: event.sessionId,
        objective: event.objective,
        scopeLevel: event.scopeLevel,
        status: 'active',
        stage: 'knowledge_base',
        round: 0,
        createdAt: event.ts,
        updatedAt: event.ts,
        artifacts: [],
        checklist: defaultDeepResearchChecklist(event.ts),
        steps: [],
        reportSections: defaultReportSections(event.ts),
        checkpoints: [],
      };
      continue;
    }

    if (!run) {
      diagnostics.push(`${event.type} appeared before research_started`);
      continue;
    }
    if (event.sessionId !== run.sessionId) {
      diagnostics.push(`${event.type} belongs to another session`);
      continue;
    }
    if (run.status === 'completed') {
      diagnostics.push(`${event.type} appeared after research_completed`);
      continue;
    }

    switch (event.type) {
      case 'research_artifact_recorded': {
        if (run.artifacts.length >= DEEP_RESEARCH_ARTIFACTS_MAX) {
          diagnostics.push(`deep research artifact cap ${DEEP_RESEARCH_ARTIFACTS_MAX} exceeded`);
          break;
        }
        const artifact = event.artifact;
        if (artifactIds.has(artifact.artifactId)) {
          diagnostics.push(`duplicate research artifact ${artifact.artifactId}`);
          break;
        }
        const sourceDiagnostic = validateSourceReferences(artifact, run.artifacts);
        if (sourceDiagnostic) {
          diagnostics.push(sourceDiagnostic);
          break;
        }
        if (artifact.role === 'report_section') {
          const currentSection = run.reportSections.find(
            (section) => section.key === artifact.reportSectionKey,
          );
          if (
            currentSection?.status === 'completed' &&
            artifact.reportSectionStatus === 'drafted'
          ) {
            diagnostics.push(
              `report section ${artifact.reportSectionKey} cannot regress to drafted`,
            );
            break;
          }
        }
        artifactIds.add(artifact.artifactId);
        const reportSections =
          artifact.role === 'report_section'
            ? applyReportSectionArtifact(run.reportSections, artifact)
            : run.reportSections;
        run = {
          ...run,
          artifacts: [
            ...run.artifacts,
            { ...artifact, sourceArtifactIds: [...artifact.sourceArtifactIds] },
          ],
          reportSections,
          updatedAt: Math.max(run.updatedAt, event.ts),
        };
        break;
      }
      case 'research_checklist_updated': {
        const item = event.item;
        const current = run.checklist.find((candidate) => candidate.itemId === item.itemId);
        if (!current || current.title !== item.title) {
          diagnostics.push(`research checklist references unknown item ${item.itemId}`);
          break;
        }
        if (
          (current.status === 'completed' || current.status === 'skipped') &&
          current.status !== item.status
        ) {
          diagnostics.push(`research checklist item ${item.itemId} is already terminal`);
          break;
        }
        const missingArtifact = item.evidenceArtifactIds.find((id) => !artifactIds.has(id));
        if (missingArtifact) {
          diagnostics.push(
            `research checklist item ${item.itemId} references unknown artifact ${missingArtifact}`,
          );
          break;
        }
        if (item.status === 'completed' && item.evidenceArtifactIds.length === 0) {
          diagnostics.push(`completed research checklist item ${item.itemId} requires evidence`);
          break;
        }
        if (item.status === 'blocked' && !item.blockedReason) {
          diagnostics.push(`blocked research checklist item ${item.itemId} requires a reason`);
          break;
        }
        const checklist = run.checklist.map((candidate) =>
          candidate.itemId === item.itemId ? cloneChecklistItem(item) : candidate,
        );
        run = {
          ...run,
          status: checklist.some((candidate) => candidate.status === 'blocked')
            ? 'blocked'
            : 'active',
          checklist,
          updatedAt: Math.max(run.updatedAt, event.ts),
        };
        break;
      }
      case 'research_step_recorded': {
        if (run.steps.length >= DEEP_RESEARCH_STEPS_MAX) {
          diagnostics.push(`deep research step cap ${DEEP_RESEARCH_STEPS_MAX} exceeded`);
          break;
        }
        const step = event.step;
        if (stepIds.has(step.stepId)) {
          diagnostics.push(`duplicate research step ${step.stepId}`);
          break;
        }
        const missingEvidence = step.evidenceArtifactIds.find((id) => !artifactIds.has(id));
        if (missingEvidence) {
          diagnostics.push(
            `research step ${step.stepId} references unknown artifact ${missingEvidence}`,
          );
          break;
        }
        const recordedArtifacts = run.artifacts;
        const invalidInspectedSource = step.inspectedRefs.find((ref) => {
          if (!ref.sourceArtifactId) return false;
          return (
            recordedArtifacts.find((artifact) => artifact.artifactId === ref.sourceArtifactId)
              ?.role !== 'source'
          );
        });
        if (invalidInspectedSource?.sourceArtifactId) {
          diagnostics.push(
            `research step ${step.stepId} references non-source artifact ${invalidInspectedSource.sourceArtifactId}`,
          );
          break;
        }
        if (step.status === 'completed' && step.evidenceArtifactIds.length === 0) {
          diagnostics.push(`completed research step ${step.stepId} requires evidence artifacts`);
          break;
        }
        if (step.status === 'blocked' && !step.blockedReason) {
          diagnostics.push(`blocked research step ${step.stepId} requires a reason`);
          break;
        }
        stepIds.add(step.stepId);
        run = {
          ...run,
          status: step.status === 'blocked' ? 'blocked' : run.status,
          steps: [...run.steps, cloneStep(step)],
          updatedAt: Math.max(run.updatedAt, event.ts),
        };
        break;
      }
      case 'research_checkpoint_recorded': {
        if (run.checkpoints.length >= DEEP_RESEARCH_CHECKPOINTS_MAX) {
          diagnostics.push(
            `deep research checkpoint cap ${DEEP_RESEARCH_CHECKPOINTS_MAX} exceeded`,
          );
          break;
        }
        const checkpoint = event.checkpoint;
        if (checkpointIds.has(checkpoint.checkpointId)) {
          diagnostics.push(`duplicate research checkpoint ${checkpoint.checkpointId}`);
          break;
        }
        if (checkpoint.round < run.round) {
          diagnostics.push(`research round regressed from ${run.round} to ${checkpoint.round}`);
          break;
        }
        if (run.stage === 'report_writing' && checkpoint.stage === 'knowledge_base') {
          diagnostics.push(
            'deep research stage cannot regress from report_writing to knowledge_base',
          );
          break;
        }
        const missingArtifact = checkpoint.artifactIds.find((id) => !artifactIds.has(id));
        if (missingArtifact) {
          diagnostics.push(`checkpoint references unknown artifact ${missingArtifact}`);
          break;
        }
        checkpointIds.add(checkpoint.checkpointId);
        run = {
          ...run,
          status: checkpoint.status,
          stage: checkpoint.stage,
          round: checkpoint.round,
          checkpoints: [...run.checkpoints, cloneCheckpoint(checkpoint)],
          updatedAt: Math.max(run.updatedAt, event.ts),
        };
        break;
      }
      case 'research_completed': {
        const report = run.artifacts.find(
          (artifact) => artifact.artifactId === event.reportArtifactId,
        );
        if (!report || report.role !== 'report') {
          diagnostics.push(
            `research_completed references missing report artifact ${event.reportArtifactId}`,
          );
          break;
        }
        if (!run.artifacts.some((artifact) => artifact.role === 'source')) {
          diagnostics.push('research_completed requires at least one archived source artifact');
          break;
        }
        const handoffArtifact = run.artifacts.find(
          (artifact) => artifact.artifactId === event.handoff.artifactId,
        );
        if (!handoffArtifact || handoffArtifact.role !== 'handoff') {
          diagnostics.push(
            `research_completed references missing handoff artifact ${event.handoff.artifactId}`,
          );
          break;
        }
        const incompleteChecklist = run.checklist.find(
          (item) => item.status !== 'completed' && item.status !== 'skipped',
        );
        if (incompleteChecklist) {
          diagnostics.push(
            `research_completed requires checklist item ${incompleteChecklist.itemId} to be settled`,
          );
          break;
        }
        const incompleteSection = run.reportSections.find(
          (section) => section.status !== 'completed',
        );
        if (incompleteSection) {
          diagnostics.push(`research_completed requires report section ${incompleteSection.key}`);
          break;
        }
        run = {
          ...run,
          status: 'completed',
          stage: 'completed',
          reportArtifactId: event.reportArtifactId,
          handoff: cloneHandoff(event.handoff),
          completedAt: event.ts,
          updatedAt: Math.max(run.updatedAt, event.ts),
        };
        break;
      }
    }
  }

  return { ...(run ? { run } : {}), diagnostics };
}

function validateSourceReferences(
  artifact: DeepResearchArtifactRef,
  existing: readonly DeepResearchArtifactRef[],
): string | undefined {
  if (artifact.role === 'source') {
    if (!artifact.locator) return `source artifact ${artifact.artifactId} requires a locator`;
    return artifact.sourceArtifactIds.length === 0
      ? undefined
      : `source artifact ${artifact.artifactId} cannot cite another source artifact`;
  }
  if (artifact.sourceArtifactIds.length === 0) {
    return `${artifact.role} artifact ${artifact.artifactId} requires source artifact references`;
  }
  const invalid = artifact.sourceArtifactIds.find((id) => {
    const source = existing.find((item) => item.artifactId === id);
    return source?.role !== 'source';
  });
  return invalid
    ? `${artifact.role} artifact ${artifact.artifactId} references non-source artifact ${invalid}`
    : undefined;
}

function isDeepResearchArtifactRef(value: unknown): value is DeepResearchArtifactRef {
  if (!isRecord(value)) return false;
  if (
    !isStableId(value.artifactId) ||
    !isDeepResearchArtifactRole(value.role) ||
    !isBoundedText(value.name, DEEP_RESEARCH_ARTIFACT_NAME_MAX_CHARS) ||
    !(
      value.summary === undefined ||
      isBoundedText(value.summary, DEEP_RESEARCH_CHECKPOINT_TEXT_MAX_CHARS)
    ) ||
    !isFiniteNumber(value.createdAt) ||
    !(
      value.locator === undefined || isBoundedText(value.locator, DEEP_RESEARCH_LOCATOR_MAX_CHARS)
    ) ||
    typeof value.contentHash !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.contentHash) ||
    !isStableIdArray(value.sourceArtifactIds, DEEP_RESEARCH_REFS_MAX)
  ) {
    return false;
  }
  if (value.role === 'report_section') {
    return (
      isDeepResearchReportSectionKey(value.reportSectionKey) &&
      (value.reportSectionStatus === 'drafted' || value.reportSectionStatus === 'completed')
    );
  }
  return value.reportSectionKey === undefined && value.reportSectionStatus === undefined;
}

function isDeepResearchChecklistItem(value: unknown): value is DeepResearchChecklistItem {
  return (
    isRecord(value) &&
    isStableId(value.itemId) &&
    isBoundedText(value.title, DEEP_RESEARCH_ARTIFACT_NAME_MAX_CHARS) &&
    isDeepResearchChecklistStatus(value.status) &&
    isStableIdArray(value.evidenceArtifactIds, DEEP_RESEARCH_REFS_MAX) &&
    (value.blockedReason === undefined ||
      isBoundedText(value.blockedReason, DEEP_RESEARCH_CHECKPOINT_TEXT_MAX_CHARS)) &&
    (value.status === 'blocked'
      ? value.blockedReason !== undefined
      : value.blockedReason === undefined) &&
    isFiniteNumber(value.updatedAt)
  );
}

function isDeepResearchStep(value: unknown): value is DeepResearchStep {
  return (
    isRecord(value) &&
    isStableId(value.stepId) &&
    isDeepResearchStepKind(value.kind) &&
    isDeepResearchStepStatus(value.status) &&
    isBoundedText(value.objective, DEEP_RESEARCH_STEP_TEXT_MAX_CHARS) &&
    isBoundedText(value.summary, DEEP_RESEARCH_STEP_TEXT_MAX_CHARS) &&
    isBoundedTextArray(
      value.roots,
      DEEP_RESEARCH_STEP_LIST_ITEMS_MAX,
      DEEP_RESEARCH_LOCATOR_MAX_CHARS,
    ) &&
    (value.kind !== 'local_exploration' || value.roots.length > 0) &&
    isBoundedTextArray(
      value.keywords,
      DEEP_RESEARCH_STEP_LIST_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    (value.kind !== 'web_research' || value.keywords.length > 0) &&
    isBoundedTextArray(
      value.ignoredPaths,
      DEEP_RESEARCH_STEP_LIST_ITEMS_MAX,
      DEEP_RESEARCH_LOCATOR_MAX_CHARS,
    ) &&
    isBoundedText(value.stoppingCondition, DEEP_RESEARCH_STEP_TEXT_MAX_CHARS) &&
    isBoundedText(value.expectedEvidence, DEEP_RESEARCH_STEP_TEXT_MAX_CHARS) &&
    isStableIdArray(value.evidenceArtifactIds, DEEP_RESEARCH_REFS_MAX) &&
    Array.isArray(value.inspectedRefs) &&
    value.inspectedRefs.length <= DEEP_RESEARCH_INSPECTED_REFS_MAX &&
    value.inspectedRefs.every(isDeepResearchInspectedRef) &&
    isStableIdArray(value.workerRunIds, DEEP_RESEARCH_REFS_MAX) &&
    (value.blockedReason === undefined ||
      isBoundedText(value.blockedReason, DEEP_RESEARCH_STEP_TEXT_MAX_CHARS)) &&
    (value.status === 'blocked'
      ? value.blockedReason !== undefined
      : value.blockedReason === undefined) &&
    isFiniteNumber(value.createdAt)
  );
}

function isDeepResearchInspectedRef(value: unknown): value is DeepResearchInspectedRef {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    (DEEP_RESEARCH_INSPECTED_REF_KINDS as readonly string[]).includes(value.kind) &&
    isBoundedText(value.locator, DEEP_RESEARCH_LOCATOR_MAX_CHARS) &&
    (value.label === undefined ||
      isBoundedText(value.label, DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS)) &&
    (value.sourceArtifactId === undefined || isStableId(value.sourceArtifactId))
  );
}

function isDeepResearchHandoff(value: unknown): value is DeepResearchHandoff {
  return (
    isRecord(value) &&
    isStableId(value.artifactId) &&
    isBoundedTextArray(
      value.implementationTasks,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    value.implementationTasks.length > 0 &&
    isBoundedTextArray(
      value.recommendedIssues,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    isBoundedTextArray(
      value.recommendedPullRequests,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    value.recommendedIssues.length + value.recommendedPullRequests.length > 0 &&
    isBoundedTextArray(
      value.verificationCommands,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    value.verificationCommands.length > 0
  );
}

function isDeepResearchCheckpoint(value: unknown): value is DeepResearchCheckpoint {
  return (
    isRecord(value) &&
    isStableId(value.checkpointId) &&
    Number.isSafeInteger(value.round) &&
    (value.round as number) >= 1 &&
    isDeepResearchActiveStage(value.stage) &&
    (value.status === 'active' || value.status === 'blocked') &&
    isBoundedText(value.summary, DEEP_RESEARCH_CHECKPOINT_TEXT_MAX_CHARS) &&
    isBoundedTextArray(
      value.openQuestions,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    isBoundedTextArray(
      value.nextSteps,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    isStableIdArray(value.taskIds, DEEP_RESEARCH_REFS_MAX) &&
    isStableIdArray(value.artifactIds, DEEP_RESEARCH_REFS_MAX) &&
    isFiniteNumber(value.createdAt)
  );
}

function isEventRefs(value: unknown): value is DeepResearchEventRefs | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !['runId', 'turnId', 'toolCallId'].includes(key))) return false;
  return [value.runId, value.turnId, value.toolCallId].every(
    (item) => item === undefined || isBoundedReference(item),
  );
}

function isBoundedReference(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512;
}

function isStableId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) &&
    redactSecrets(value) === value
  );
}

function isStableIdArray(value: unknown, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    new Set(value).size === value.length &&
    value.every(isStableId)
  );
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= max;
}

function isBoundedTextArray(value: unknown, maxItems: number, maxChars: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => isBoundedText(item, maxChars))
  );
}

function cloneCheckpoint(checkpoint: DeepResearchCheckpoint): DeepResearchCheckpoint {
  return {
    ...checkpoint,
    openQuestions: [...checkpoint.openQuestions],
    nextSteps: [...checkpoint.nextSteps],
    taskIds: [...checkpoint.taskIds],
    artifactIds: [...checkpoint.artifactIds],
  };
}

function defaultDeepResearchChecklist(ts: number): DeepResearchChecklistItem[] {
  return DEEP_RESEARCH_DEFAULT_CHECKLIST.map((item) => ({
    ...item,
    status: 'pending',
    evidenceArtifactIds: [],
    updatedAt: ts,
  }));
}

function defaultReportSections(ts: number): DeepResearchReportSectionState[] {
  return DEEP_RESEARCH_REPORT_SECTION_KEYS.map((key) => ({
    key,
    status: 'pending',
    updatedAt: ts,
  }));
}

function applyReportSectionArtifact(
  sections: readonly DeepResearchReportSectionState[],
  artifact: DeepResearchArtifactRef,
): DeepResearchReportSectionState[] {
  if (
    artifact.role !== 'report_section' ||
    !artifact.reportSectionKey ||
    !artifact.reportSectionStatus
  ) {
    return [...sections];
  }
  return sections.map((section) =>
    section.key === artifact.reportSectionKey
      ? {
          key: section.key,
          status: artifact.reportSectionStatus!,
          artifactId: artifact.artifactId,
          updatedAt: artifact.createdAt,
        }
      : section,
  );
}

function cloneChecklistItem(item: DeepResearchChecklistItem): DeepResearchChecklistItem {
  return {
    ...item,
    evidenceArtifactIds: [...item.evidenceArtifactIds],
  };
}

function cloneStep(step: DeepResearchStep): DeepResearchStep {
  return {
    ...step,
    roots: [...step.roots],
    keywords: [...step.keywords],
    ignoredPaths: [...step.ignoredPaths],
    evidenceArtifactIds: [...step.evidenceArtifactIds],
    inspectedRefs: step.inspectedRefs.map((ref) => ({ ...ref })),
    workerRunIds: [...step.workerRunIds],
  };
}

function cloneHandoff(handoff: DeepResearchHandoff): DeepResearchHandoff {
  return {
    ...handoff,
    implementationTasks: [...handoff.implementationTasks],
    recommendedIssues: [...handoff.recommendedIssues],
    recommendedPullRequests: [...handoff.recommendedPullRequests],
    verificationCommands: [...handoff.verificationCommands],
  };
}
