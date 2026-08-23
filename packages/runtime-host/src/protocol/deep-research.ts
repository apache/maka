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

import {
  DEEP_RESEARCH_CHECKLIST_ITEMS_MAX,
  DEEP_RESEARCH_CLIENT_IMPLEMENTATION_PROMPT_MAX_BYTES,
  DEEP_RESEARCH_CLIENT_OBJECTIVE_MAX_BYTES,
  DEEP_RESEARCH_CLIENT_RECENT_ITEMS_MAX,
  DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES,
  DEEP_RESEARCH_INSPECTED_REF_KINDS,
  DEEP_RESEARCH_REPORT_SECTION_KEYS,
  DEEP_RESEARCH_REPORT_SECTION_STATUSES,
  DEEP_RESEARCH_RUN_STATUSES,
  DEEP_RESEARCH_SCOPE_LEVELS,
  DEEP_RESEARCH_STAGES,
  DEEP_RESEARCH_CHECKLIST_STATUSES,
  type DeepResearchChecklistStatus,
  type DeepResearchClientProgress,
  type DeepResearchInspectedRefKind,
  type DeepResearchReportSectionKey,
  type DeepResearchReportSectionStatus,
  type DeepResearchRunStatus,
  type DeepResearchScopeLevel,
  type DeepResearchStage,
} from '@maka/core/deep-research-run';
import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const DEEP_RESEARCH_RESULT_MAX_BYTES = 48 * 1024;
export const DEEP_RESEARCH_RECENT_REFS_MAX = DEEP_RESEARCH_CLIENT_RECENT_ITEMS_MAX;
export { DEEP_RESEARCH_CLIENT_OBJECTIVE_MAX_BYTES, DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES };
export const DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_BYTES =
  DEEP_RESEARCH_CLIENT_IMPLEMENTATION_PROMPT_MAX_BYTES;
const DEEP_RESEARCH_STABLE_ID_MAX_BYTES = 128;
const DEEP_RESEARCH_STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'invalid_request',
  'internal_failure',
] as const;

export interface DeepResearchQueryInput {
  readonly sessionId: string;
}

export interface DeepResearchChecklistProjection {
  readonly itemId: string;
  readonly title: string;
  readonly status: DeepResearchChecklistStatus;
  readonly blockedReason: string | null;
}

export interface DeepResearchReportSectionProjection {
  readonly key: DeepResearchReportSectionKey;
  readonly status: DeepResearchReportSectionStatus;
}

export interface DeepResearchInspectedRefProjection {
  readonly kind: DeepResearchInspectedRefKind;
  readonly locator: string;
  readonly label: string | null;
}

export type DeepResearchQueryResult =
  | {
      readonly kind: 'not_started';
      readonly sessionId: string;
      readonly revision: 0;
    }
  | {
      readonly kind: 'snapshot';
      readonly sessionId: string;
      readonly revision: number;
      readonly objective: string;
      readonly scopeLevel: DeepResearchScopeLevel;
      readonly status: DeepResearchRunStatus;
      readonly stage: DeepResearchStage;
      readonly round: number;
      readonly createdAt: number;
      readonly updatedAt: number;
      readonly artifactsCount: number;
      readonly stepsCount: number;
      readonly checklist: readonly DeepResearchChecklistProjection[];
      readonly reportSections: readonly DeepResearchReportSectionProjection[];
      readonly recentInspectedRefs: readonly DeepResearchInspectedRefProjection[];
      readonly workerRunIds: readonly string[];
      readonly blockers: readonly string[];
      readonly reportArtifactId: string | null;
      readonly implementationPrompt: string | null;
    };

export function encodeDeepResearchSnapshot(
  progress: DeepResearchClientProgress,
  revision: number,
): Extract<DeepResearchQueryResult, { kind: 'snapshot' }> {
  return decodeDeepResearchQueryResult({
    kind: 'snapshot',
    revision,
    ...progress,
    checklist: progress.checklist.map((item) => ({
      ...item,
      blockedReason: item.blockedReason ?? null,
    })),
    recentInspectedRefs: progress.recentInspectedRefs.map((ref) => ({
      ...ref,
      label: ref.label ?? null,
    })),
    reportArtifactId: progress.reportArtifactId ?? null,
    implementationPrompt: progress.implementationPrompt ?? null,
  }) as Extract<DeepResearchQueryResult, { kind: 'snapshot' }>;
}

export const DEEP_RESEARCH_OPERATION_SPECS = {
  'deep-research.query': defineOperation<
    DeepResearchQueryInput,
    DeepResearchQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeDeepResearchQueryInput,
    decodeOutput: decodeDeepResearchQueryResult,
    assertOutputForInput(input, output) {
      if (output.sessionId !== input.sessionId) {
        throw invalidProtocolFrame('Deep Research result belongs to a different Session');
      }
    },
  }),
} as const;

export function decodeDeepResearchQueryInput(value: unknown): DeepResearchQueryInput {
  const input = requireExactRecord(value, 'Deep Research query input', ['sessionId']);
  return { sessionId: requireEntityId(input.sessionId, 'sessionId') };
}

export function decodeDeepResearchQueryResult(value: unknown): DeepResearchQueryResult {
  requireEncodedByteLimit(value, 'Deep Research query result', DEEP_RESEARCH_RESULT_MAX_BYTES);
  const record = requireShapedRecord(
    value,
    'Deep Research query result',
    ['kind', 'sessionId', 'revision'],
    [
      'objective',
      'scopeLevel',
      'status',
      'stage',
      'round',
      'createdAt',
      'updatedAt',
      'artifactsCount',
      'stepsCount',
      'checklist',
      'reportSections',
      'recentInspectedRefs',
      'workerRunIds',
      'blockers',
      'reportArtifactId',
      'implementationPrompt',
    ],
  );
  const sessionId = requireEntityId(record.sessionId, 'sessionId');
  const revision = requireCount(record.revision, 'Deep Research revision');
  if (record.kind === 'not_started') {
    requireExactRecord(record, 'Deep Research not-started result', [
      'kind',
      'sessionId',
      'revision',
    ]);
    if (revision !== 0) throw invalidProtocolFrame('Invalid Deep Research not-started revision');
    return { kind: 'not_started', sessionId, revision: 0 };
  }
  if (record.kind !== 'snapshot') {
    throw invalidProtocolFrame('Invalid Deep Research query result kind');
  }
  requireExactRecord(record, 'Deep Research snapshot result', [
    'kind',
    'sessionId',
    'revision',
    'objective',
    'scopeLevel',
    'status',
    'stage',
    'round',
    'createdAt',
    'updatedAt',
    'artifactsCount',
    'stepsCount',
    'checklist',
    'reportSections',
    'recentInspectedRefs',
    'workerRunIds',
    'blockers',
    'reportArtifactId',
    'implementationPrompt',
  ]);
  if (revision === 0) throw invalidProtocolFrame('Invalid Deep Research snapshot revision');
  return {
    kind: 'snapshot',
    sessionId,
    revision,
    objective: requireUtf8String(
      record.objective,
      'Deep Research objective',
      DEEP_RESEARCH_CLIENT_OBJECTIVE_MAX_BYTES,
    ),
    scopeLevel: requireEnum(
      record.scopeLevel,
      DEEP_RESEARCH_SCOPE_LEVELS,
      'Deep Research scope level',
    ),
    status: requireEnum(record.status, DEEP_RESEARCH_RUN_STATUSES, 'Deep Research status'),
    stage: requireEnum(record.stage, DEEP_RESEARCH_STAGES, 'Deep Research stage'),
    round: requireCount(record.round, 'Deep Research round'),
    createdAt: requireCount(record.createdAt, 'Deep Research createdAt'),
    updatedAt: requireCount(record.updatedAt, 'Deep Research updatedAt'),
    artifactsCount: requireCount(record.artifactsCount, 'Deep Research artifact count'),
    stepsCount: requireCount(record.stepsCount, 'Deep Research step count'),
    checklist: decodeChecklist(record.checklist),
    reportSections: decodeReportSections(record.reportSections),
    recentInspectedRefs: decodeInspectedRefs(record.recentInspectedRefs),
    workerRunIds: decodeIds(record.workerRunIds, 'Deep Research worker run ids'),
    blockers: decodeTexts(record.blockers, 'Deep Research blockers'),
    reportArtifactId: nullableId(record.reportArtifactId, 'Deep Research report artifact id'),
    implementationPrompt: nullableText(
      record.implementationPrompt,
      'Deep Research implementation prompt',
      DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_BYTES,
    ),
  };
}

function decodeTexts(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > DEEP_RESEARCH_RECENT_REFS_MAX) {
    throw invalidProtocolFrame(`Invalid ${name}`);
  }
  return value.map((item) => requireUtf8String(item, name, DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES));
}

function decodeChecklist(value: unknown): DeepResearchChecklistProjection[] {
  if (!Array.isArray(value) || value.length > DEEP_RESEARCH_CHECKLIST_ITEMS_MAX) {
    throw invalidProtocolFrame('Invalid Deep Research checklist');
  }
  return value.map((candidate) => {
    const item = requireExactRecord(candidate, 'Deep Research checklist item', [
      'itemId',
      'title',
      'status',
      'blockedReason',
    ]);
    return {
      itemId: requireEntityId(item.itemId, 'Deep Research checklist item id'),
      title: requireUtf8String(
        item.title,
        'Deep Research checklist title',
        DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES,
      ),
      status: requireEnum(
        item.status,
        DEEP_RESEARCH_CHECKLIST_STATUSES,
        'Deep Research checklist status',
      ),
      blockedReason: nullableText(
        item.blockedReason,
        'Deep Research checklist blocker',
        DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES,
      ),
    };
  });
}

function decodeReportSections(value: unknown): DeepResearchReportSectionProjection[] {
  if (!Array.isArray(value) || value.length > DEEP_RESEARCH_REPORT_SECTION_KEYS.length) {
    throw invalidProtocolFrame('Invalid Deep Research report sections');
  }
  return value.map((candidate) => {
    const section = requireExactRecord(candidate, 'Deep Research report section', [
      'key',
      'status',
    ]);
    return {
      key: requireEnum(
        section.key,
        DEEP_RESEARCH_REPORT_SECTION_KEYS,
        'Deep Research report section key',
      ),
      status: requireEnum(
        section.status,
        DEEP_RESEARCH_REPORT_SECTION_STATUSES,
        'Deep Research report section status',
      ),
    };
  });
}

function decodeInspectedRefs(value: unknown): DeepResearchInspectedRefProjection[] {
  if (!Array.isArray(value) || value.length > DEEP_RESEARCH_RECENT_REFS_MAX) {
    throw invalidProtocolFrame('Invalid Deep Research inspected refs');
  }
  return value.map((candidate) => {
    const ref = requireExactRecord(candidate, 'Deep Research inspected ref', [
      'kind',
      'locator',
      'label',
    ]);
    return {
      kind: requireEnum(
        ref.kind,
        DEEP_RESEARCH_INSPECTED_REF_KINDS,
        'Deep Research inspected ref kind',
      ),
      locator: requireUtf8String(
        ref.locator,
        'Deep Research inspected ref locator',
        DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES,
      ),
      label: nullableText(
        ref.label,
        'Deep Research inspected ref label',
        DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES,
      ),
    };
  });
}

function decodeIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > DEEP_RESEARCH_RECENT_REFS_MAX) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value.map((candidate) => requireStableResearchId(candidate, label));
}

function nullableId(value: unknown, label: string): string | null {
  return value === null ? null : requireEntityId(value, label);
}

function nullableText(value: unknown, label: string, maxBytes: number): string | null {
  return value === null ? null : requireUtf8String(value, label, maxBytes);
}

function requireStableResearchId(value: unknown, label: string): string {
  const id = requireUtf8String(value, label, DEEP_RESEARCH_STABLE_ID_MAX_BYTES);
  if (!DEEP_RESEARCH_STABLE_ID.test(id)) throw invalidProtocolFrame(`Invalid ${label}`);
  return id;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as T[number];
}
