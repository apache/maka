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

import { stableJsonStringify } from '@maka/core/canonical-json';
import { expandExperiment, type ExperimentCell, type ExperimentSpec } from './experiment.js';
import { decodeEvalResult, type EvalResult } from './result.js';
import { parseExperimentSpec } from './spec.js';

/** A worker ID identifies one process incarnation, not a reusable VM hostname. */
export interface FleetWorkerDescription {
  id: string;
  environmentId: string;
  cpus: number;
  memoryMb: number;
  groupSlots: number;
}

export interface FleetPolicy {
  runId: string;
  /** Identity of the reviewed code, benchmark, toolchain and image manifest. */
  environmentId: string;
  /** Must cover both subject execution and verification for one entire group. */
  groupCpus: number;
  groupMemoryMb: number;
  leaseMs: number;
  recoveryGraceMs: number;
  retryBackoffMs: number;
  maxAttemptsPerCell: number;
}

export interface FleetArtifact {
  sha256: string;
  bytes: number;
}

/** Evidence comes from the execution adapter, never from provider-error parsing here. */
export interface FleetReport {
  result: EvalResult;
  execution: 'completed' | 'subject_failed' | 'not_started' | 'unknown';
  verification: 'valid' | 'invalid' | 'not_run';
  usage: 'complete' | 'partial' | 'missing';
  cleanup: 'confirmed' | 'unknown';
  artifacts: FleetArtifact[];
  /** A deterministic environment defect blocks this run until explicitly repaired. */
  environmentFailure: string | null;
}

export interface FleetAttempt {
  id: string;
  cellId: string;
  sequence: number;
  assignmentId: string;
  report: FleetReport | null;
  disposition: 'pending' | 'selected' | 'retryable' | 'late';
}

export interface FleetAssignment {
  id: string;
  groupId: string;
  workerId: string;
  generation: number;
  attemptIds: string[];
  status: 'active' | 'finished' | 'expired';
  expiresAt: number;
}

export interface FleetState {
  version: 'maka.eval.fleet.v1';
  spec: ExperimentSpec;
  policy: FleetPolicy;
  clock: number;
  nextAssignment: number;
  workers: { description: FleetWorkerDescription; reconciled: boolean }[];
  groups: { id: string; cellIds: string[]; generation: number; readyAt: number }[];
  assignments: FleetAssignment[];
  attempts: FleetAttempt[];
  blocked: string[];
  paused: boolean;
}

export type FleetCommand =
  | { kind: 'register'; worker: FleetWorkerDescription }
  | { kind: 'claim'; workerId: string }
  | { kind: 'heartbeat'; workerId: string; assignmentIds: string[] }
  | { kind: 'report'; workerId: string; attemptId: string; report: FleetReport }
  | { kind: 'finish'; workerId: string; assignmentId: string }
  | { kind: 'recover' }
  | { kind: 'pause' }
  | { kind: 'tick' }
  | { kind: 'repair'; reason: string };

export type FleetWorkerCommand = Extract<
  FleetCommand,
  { kind: 'register' | 'claim' | 'heartbeat' | 'report' | 'finish' }
>;

export interface FleetReply {
  assignment?: FleetAssignment;
  disposition?: FleetAttempt['disposition'];
  activeAssignmentIds?: string[];
  work?: FleetWork[];
}

export interface FleetWork {
  assignment: FleetAssignment;
  cells: { attemptId: string; cell: ExperimentCell }[];
}

export function createFleetState(spec: ExperimentSpec, policy: FleetPolicy): FleetState {
  const frozenSpec = parseExperimentSpec(spec);
  for (const key of ['runId', 'environmentId'] as const) nonempty(policy[key], key);
  for (const key of [
    'groupCpus',
    'groupMemoryMb',
    'leaseMs',
    'recoveryGraceMs',
    'maxAttemptsPerCell',
  ] as const)
    positive(policy[key], key);
  if (!Number.isSafeInteger(policy.retryBackoffMs) || policy.retryBackoffMs < 0) {
    throw new Error('invalid retryBackoffMs');
  }
  const groups = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const cell of expandExperiment(frozenSpec)) {
    if (ids.has(cell.id)) throw new Error('ambiguous experiment cell identity');
    ids.add(cell.id);
    const id = JSON.stringify([cell.task.id, cell.repetition]);
    const group = groups.get(id) ?? [];
    group.push(cell.id);
    groups.set(id, group);
  }
  return {
    version: 'maka.eval.fleet.v1',
    spec: frozenSpec,
    policy: structuredClone(policy),
    clock: 0,
    nextAssignment: 1,
    workers: [],
    assignments: [],
    attempts: [],
    blocked: [],
    paused: false,
    groups: [...groups].map(([id, cellIds]) => ({ id, cellIds, generation: 0, readyAt: 0 })),
  };
}

/** Pure deterministic transition. Persist the returned state before delivering its reply. */
export function transitionFleet(
  previous: FleetState,
  command: FleetCommand,
  now: number,
): { state: FleetState; reply: FleetReply } {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid fleet clock');
  const state = structuredClone(previous);
  state.clock = Math.max(state.clock, now);
  if (command.kind === 'pause') {
    state.paused = true;
    return { state, reply: {} };
  }
  // Recovery must run BEFORE expiry: a coordinator outage is not evidence of VM loss.
  if (command.kind === 'recover') {
    state.paused = false;
    for (const worker of state.workers) worker.reconciled = false;
    for (const assignment of active(state)) {
      assignment.expiresAt = Math.max(
        assignment.expiresAt,
        state.clock + state.policy.recoveryGraceMs,
      );
    }
    return { state, reply: {} };
  }
  for (const assignment of active(state)) {
    if (!state.paused && assignment.expiresAt <= state.clock) settle(state, assignment, 'expired');
  }
  const reply: FleetReply = {};
  switch (command.kind) {
    case 'register': {
      const description = command.worker;
      nonempty(description.id, 'worker id');
      positive(description.groupSlots, 'groupSlots');
      positive(description.cpus, 'cpus');
      positive(description.memoryMb, 'memoryMb');
      if (
        description.environmentId !== state.policy.environmentId ||
        description.cpus < description.groupSlots * state.policy.groupCpus ||
        description.memoryMb < description.groupSlots * state.policy.groupMemoryMb
      ) {
        throw new Error('worker does not satisfy execution and verifier admission');
      }
      const existing = state.workers.find((w) => w.description.id === description.id);
      if (
        existing &&
        stableJsonStringify(existing.description) !== stableJsonStringify(description)
      ) {
        throw new Error('worker incarnation changed description');
      }
      if (!existing)
        state.workers.push({ description: structuredClone(description), reconciled: false });
      break;
    }
    case 'heartbeat': {
      const worker = requireWorker(state, command.workerId);
      if (new Set(command.assignmentIds).size !== command.assignmentIds.length) {
        throw new Error('duplicate heartbeat assignment');
      }
      for (const id of command.assignmentIds) {
        const assignment = requireAssignment(state, command.workerId, id);
        if (assignment.status === 'active')
          assignment.expiresAt = state.clock + state.policy.leaseMs;
      }
      // Omitted assignments are allowed to expire; they are not silently renewed.
      worker.reconciled = true;
      reply.activeAssignmentIds = active(state)
        .filter((a) => a.workerId === command.workerId)
        .map((a) => a.id);
      // Includes a claim whose reply was lost. The worker can adopt it rather than leak a slot.
      reply.work = active(state)
        .filter((a) => a.workerId === command.workerId)
        .map((a) => workFor(state, a));
      break;
    }
    case 'claim': {
      const worker = requireWorker(state, command.workerId);
      const running = active(state);
      if (
        state.paused ||
        !worker.reconciled ||
        state.blocked.length ||
        running.length >= state.spec.execution.maxConcurrentTaskGroups ||
        running.filter((a) => a.workerId === command.workerId).length >=
          worker.description.groupSlots
      )
        break;
      const group = state.groups.find(
        (g) =>
          g.readyAt <= state.clock &&
          !running.some((a) => a.groupId === g.id) &&
          pendingCells(state, g.cellIds).length > 0,
      );
      if (!group) break;
      const id = `${state.policy.runId}/assignment-${state.nextAssignment++}`;
      const attempts = pendingCells(state, group.cellIds).map(
        (cellId, index): FleetAttempt => ({
          id: `${id}/attempt-${index + 1}`,
          cellId,
          sequence: state.attempts.filter((a) => a.cellId === cellId).length + 1,
          assignmentId: id,
          report: null,
          disposition: 'pending',
        }),
      );
      const assignment: FleetAssignment = {
        id,
        groupId: group.id,
        workerId: command.workerId,
        generation: ++group.generation,
        attemptIds: attempts.map((a) => a.id),
        status: 'active',
        expiresAt: state.clock + state.policy.leaseMs,
      };
      state.attempts.push(...attempts);
      state.assignments.push(assignment);
      reply.assignment = structuredClone(assignment);
      reply.work = [workFor(state, assignment)];
      break;
    }
    case 'report': {
      const attempt = state.attempts.find((a) => a.id === command.attemptId);
      if (!attempt) throw new Error('unknown attempt');
      const assignment = requireAssignment(state, command.workerId, attempt.assignmentId);
      const report = validateFleetReport(command.report);
      if (attempt.report) {
        if (stableJsonStringify(attempt.report) !== stableJsonStringify(report)) {
          throw new Error('conflicting attempt report');
        }
      } else {
        attempt.report = report;
        attempt.disposition =
          assignment.status !== 'active' ? 'late' : selectable(report) ? 'selected' : 'retryable';
        if (
          attempt.disposition !== 'late' &&
          report.environmentFailure &&
          !state.blocked.includes(report.environmentFailure)
        )
          state.blocked.push(report.environmentFailure);
      }
      reply.disposition = attempt.disposition;
      break;
    }
    case 'finish': {
      const assignment = requireAssignment(state, command.workerId, command.assignmentId);
      if (assignment.status !== 'active') break;
      if (assignment.attemptIds.some((id) => !state.attempts.find((a) => a.id === id)?.report)) {
        throw new Error('cannot finish before all cell reports are committed');
      }
      settle(state, assignment, 'finished');
      break;
    }
    case 'repair':
      state.blocked = state.blocked.filter((reason) => reason !== command.reason);
      break;
    case 'tick':
      break;
  }
  return { state, reply };
}

export function summarizeFleet(state: FleetState) {
  const selected = state.attempts.filter((a) => a.disposition === 'selected');
  const cells = state.groups.flatMap((g) => g.cellIds);
  const running = active(state);
  const exhausted = cells.filter(
    (id) =>
      !selected.some((a) => a.cellId === id) &&
      !running.some((a) =>
        a.attemptIds.some((attemptId) =>
          state.attempts.some((attempt) => attempt.id === attemptId && attempt.cellId === id),
        ),
      ) &&
      state.attempts.filter((a) => a.cellId === id).length >= state.policy.maxAttemptsPerCell,
  );
  const reported = state.attempts.filter((a) => a.report);
  return {
    runId: state.policy.runId,
    totalCells: cells.length,
    completedCells: selected.length,
    incompleteCells: cells.length - selected.length,
    exhaustedCells: exhausted.length,
    activeGroups: running.length,
    blocked: [...state.blocked],
    paused: state.paused,
    settled: running.length === 0 && cells.length === selected.length + exhausted.length,
    observedCostUsd: reported.reduce((sum, a) => sum + (a.report!.result.costUsd ?? 0), 0),
    usageComplete: state.attempts.every((a) => a.report?.usage === 'complete'),
    results: selected.map((a) => ({
      cellId: a.cellId,
      attemptId: a.id,
      result: selectedResult(a.report!),
      artifacts: structuredClone(a.report!.artifacts),
    })),
  };
}

export function validateFleetReport(value: FleetReport): FleetReport {
  const report = structuredClone(value);
  report.result = decodeEvalResult(value.result);
  member(report.execution, ['completed', 'subject_failed', 'not_started', 'unknown'], 'execution');
  member(report.verification, ['valid', 'invalid', 'not_run'], 'verification');
  member(report.usage, ['complete', 'partial', 'missing'], 'usage');
  member(report.cleanup, ['confirmed', 'unknown'], 'cleanup');
  if (report.environmentFailure !== null) nonempty(report.environmentFailure, 'environmentFailure');
  if (!Array.isArray(report.artifacts)) throw new Error('invalid artifacts');
  for (const artifact of report.artifacts) {
    if (
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0
    ) {
      throw new Error('invalid artifact reference');
    }
  }
  if (report.usage === 'missing' && report.result.usage !== null)
    throw new Error('missing usage has tokens');
  if (report.usage === 'complete' && report.result.usage === null)
    throw new Error('complete usage lacks tokens');
  if (report.usage !== 'complete' && report.result.costUsd !== null)
    throw new Error('incomplete usage has settled cost');
  if (
    report.verification === 'valid' &&
    (report.result.score === null || !['completed', 'subject_failed'].includes(report.execution))
  )
    throw new Error('invalid verification evidence');
  return report;
}

function selectedResult(report: FleetReport): EvalResult {
  // Keep raw execution evidence in the attempt; project settled status only in selected results.
  return {
    ...report.result,
    status:
      report.execution === 'subject_failed' || report.result.status === 'subject_failed'
        ? 'subject_failed'
        : 'completed',
  };
}

function selectable(report: FleetReport) {
  return (
    ['completed', 'subject_failed'].includes(report.execution) &&
    report.verification === 'valid' &&
    report.cleanup === 'confirmed' &&
    report.environmentFailure === null
  );
}

function active(state: FleetState) {
  return state.assignments.filter((a) => a.status === 'active');
}
function workFor(state: FleetState, assignment: FleetAssignment): FleetWork {
  const cells = expandExperiment(state.spec);
  return {
    assignment: structuredClone(assignment),
    cells: assignment.attemptIds.flatMap((id) => {
      const attempt = state.attempts.find((a) => a.id === id)!;
      return attempt.report
        ? []
        : [{ attemptId: id, cell: cells.find((c) => c.id === attempt.cellId)! }];
    }),
  };
}
function pendingCells(state: FleetState, ids: string[]) {
  return ids.filter(
    (id) =>
      !state.attempts.some((a) => a.cellId === id && a.disposition === 'selected') &&
      state.attempts.filter((a) => a.cellId === id).length < state.policy.maxAttemptsPerCell,
  );
}
function requireWorker(state: FleetState, id: string) {
  const worker = state.workers.find((w) => w.description.id === id);
  if (!worker) throw new Error('unknown worker incarnation');
  return worker;
}
function requireAssignment(state: FleetState, workerId: string, id: string) {
  const assignment = state.assignments.find((a) => a.id === id);
  if (!assignment || assignment.workerId !== workerId)
    throw new Error('unknown or foreign assignment');
  return assignment;
}
function settle(state: FleetState, assignment: FleetAssignment, status: 'finished' | 'expired') {
  assignment.status = status;
  state.groups.find((g) => g.id === assignment.groupId)!.readyAt =
    state.clock + state.policy.retryBackoffMs;
}
function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`);
}
function nonempty(value: string, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid ${name}`);
}
function member(value: string, values: string[], name: string) {
  if (!values.includes(value)) throw new Error(`invalid ${name}`);
}
