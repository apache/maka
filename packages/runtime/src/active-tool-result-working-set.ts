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

export type ActiveToolResultSupersessionReason =
  | 'exact_duplicate'
  | 'newer_read_covers_range'
  | 'newer_snapshot'
  | 'failure_resolved';

export interface ActiveToolResultCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  stepNumber: number;
}

export interface ActiveToolResultObservation {
  toolCallId: string;
  toolName: string;
  input: unknown;
  stepNumber: number;
  bodySha256: string;
  isError: boolean;
  eligible: boolean;
}

export interface ActiveToolResultSupersession {
  reason: ActiveToolResultSupersessionReason;
  supersededByToolCallId: string;
  /** Stable evidence fingerprint retained when a newer success resolves a failure. */
  failureBodySha256?: string;
}

const MAX_NEWER_READ_CANDIDATES_PER_PATH = 64;

interface ReadDescriptor {
  kind: 'read';
  path: string;
  start: number;
  end: number;
}

interface SnapshotDescriptor {
  kind: 'snapshot';
  key: string;
}

type ObservationDescriptor = ReadDescriptor | SnapshotDescriptor;

/**
 * Select provider-visible results that a strictly newer completed step makes
 * redundant. The planner is intentionally deterministic and conservative:
 * parallel calls in one step never supersede each other, error results never
 * replace successful evidence, and unknown tools only participate in exact
 * input-and-output deduplication.
 */
export function planActiveToolResultSupersession(
  observations: readonly ActiveToolResultObservation[],
): Map<string, ActiveToolResultSupersession> {
  const decisions = new Map<string, ActiveToolResultSupersession>();
  const newestExact = new Map<string, ActiveToolResultObservation>();
  const newerReads = new Map<string, ActiveToolResultObservation[]>();
  const newestSnapshots = new Map<string, ActiveToolResultObservation>();

  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index]!;
    const exactKey = exactObservationKey(observation);
    const exactReplacement = newestExact.get(exactKey);
    if (
      observation.eligible &&
      exactReplacement &&
      exactReplacement.stepNumber > observation.stepNumber
    ) {
      decisions.set(observation.toolCallId, {
        reason: 'exact_duplicate',
        supersededByToolCallId: exactReplacement.toolCallId,
      });
    }

    const descriptor = describeObservation(observation.toolName, observation.input);
    if (observation.eligible && !decisions.has(observation.toolCallId) && descriptor) {
      const replacement = findSemanticReplacement(
        observation,
        descriptor,
        newerReads,
        newestSnapshots,
      );
      if (replacement) decisions.set(observation.toolCallId, replacement);
    }

    if (!newestExact.has(exactKey)) newestExact.set(exactKey, observation);
    if (observation.isError || !descriptor) continue;
    if (descriptor.kind === 'read') {
      const reads = newerReads.get(descriptor.path) ?? [];
      if (reads.length < MAX_NEWER_READ_CANDIDATES_PER_PATH) reads.push(observation);
      newerReads.set(descriptor.path, reads);
    } else if (!newestSnapshots.has(descriptor.key)) {
      newestSnapshots.set(descriptor.key, observation);
    }
  }

  return decisions;
}

function findSemanticReplacement(
  observation: ActiveToolResultObservation,
  descriptor: ObservationDescriptor,
  newerReads: ReadonlyMap<string, readonly ActiveToolResultObservation[]>,
  newestSnapshots: ReadonlyMap<string, ActiveToolResultObservation>,
): ActiveToolResultSupersession | undefined {
  let replacement: ActiveToolResultObservation | undefined;
  if (descriptor.kind === 'read') {
    replacement = newerReads.get(descriptor.path)?.find((candidate) => {
      if (candidate.stepNumber <= observation.stepNumber) return false;
      const candidateDescriptor = describeRead(candidate.input);
      return Boolean(candidateDescriptor && readCovers(candidateDescriptor, descriptor));
    });
  } else {
    const candidate = newestSnapshots.get(descriptor.key);
    if (candidate && candidate.stepNumber > observation.stepNumber) replacement = candidate;
  }
  if (!replacement) return undefined;
  return {
    reason: observation.isError
      ? 'failure_resolved'
      : descriptor.kind === 'read'
        ? 'newer_read_covers_range'
        : 'newer_snapshot',
    supersededByToolCallId: replacement.toolCallId,
    ...(observation.isError ? { failureBodySha256: observation.bodySha256 } : {}),
  };
}

function exactObservationKey(observation: ActiveToolResultObservation): string {
  return `${observation.toolName}\u0000${stableStringify(observation.input)}\u0000${observation.isError ? 'error' : 'success'}\u0000${observation.bodySha256}`;
}

function describeObservation(toolName: string, input: unknown): ObservationDescriptor | undefined {
  if (toolName === 'Read') return describeRead(input);
  if (toolName === 'Glob') return describeGlob(input);
  if (toolName === 'Grep') return describeGrep(input);
  if (toolName === 'Bash') return describeBash(input);
  return undefined;
}

function describeRead(input: unknown): ReadDescriptor | undefined {
  const record = asRecord(input);
  if (!record || typeof record.path !== 'string' || record.path.length === 0) {
    return undefined;
  }
  const start = nonNegativeInteger(record.offset) ?? 0;
  const limit = positiveInteger(record.limit);
  return {
    kind: 'read',
    path: normalizeSubjectPath(record.path),
    start,
    end: limit === undefined ? Number.POSITIVE_INFINITY : start + limit,
  };
}

function describeGlob(input: unknown): SnapshotDescriptor | undefined {
  const record = asRecord(input);
  if (!record || typeof record.pattern !== 'string') return undefined;
  if (record.cwd !== undefined && typeof record.cwd !== 'string') return undefined;
  return {
    kind: 'snapshot',
    key: `Glob\u0000${stableStringify({
      pattern: record.pattern,
      cwd: normalizeSubjectPath(record.cwd ?? '.'),
    })}`,
  };
}

function describeGrep(input: unknown): SnapshotDescriptor | undefined {
  const record = asRecord(input);
  if (!record || typeof record.pattern !== 'string') return undefined;
  if (record.path !== undefined && typeof record.path !== 'string') return undefined;
  if (record.glob !== undefined && typeof record.glob !== 'string') return undefined;
  return {
    kind: 'snapshot',
    key: `Grep\u0000${stableStringify({
      pattern: record.pattern,
      path: normalizeSubjectPath(record.path ?? '.'),
      glob: record.glob ?? null,
    })}`,
  };
}

function describeBash(input: unknown): SnapshotDescriptor | undefined {
  const record = asRecord(input);
  if (!record || typeof record.command !== 'string') return undefined;
  if (
    (record.run_in_background !== undefined && typeof record.run_in_background !== 'boolean') ||
    (record.pty !== undefined && typeof record.pty !== 'boolean')
  ) {
    return undefined;
  }
  // Background and PTY results are process handles or terminal snapshots, not
  // newer observations of a foreground command. Keep each one independently
  // visible; exact input-and-output deduplication still handles true repeats.
  if (record.run_in_background === true || record.pty === true) return undefined;
  const command = record.command.trim();
  if (!isSupportedGitSnapshotCommand(command)) return undefined;
  return { kind: 'snapshot', key: `Bash\u0000${command}` };
}

function isSupportedGitSnapshotCommand(command: string): boolean {
  if (command.length === 0 || /[;&|<>`\n\r]/.test(command) || command.includes('$(')) return false;
  // Executable test/build output is evidence from a particular run, not a
  // snapshot of current state: an incremental rerun can omit an earlier
  // warning, and a passing rerun must not erase a flaky failure. Those calls
  // remain eligible for exact input-and-output deduplication only.
  return /^git(?:\s+-C\s+\S+)?\s+(?:status|diff|log|show|branch|rev-parse)(?:\s|$)/.test(command);
}

function readCovers(candidate: ReadDescriptor, original: ReadDescriptor): boolean {
  return candidate.start <= original.start && candidate.end >= original.end;
}

function normalizeSubjectPath(value: string): string {
  // Keep identity lexical and platform-independent. Leading whitespace and
  // backslashes are valid POSIX filename characters, repeated leading slashes
  // can carry implementation-defined meaning, and a Windows UNC prefix must
  // not collapse into a POSIX-looking path. Removing an explicit leading `./`
  // segment is the only equivalence shared by the supported executors. Prefer
  // false negatives here: semantic supersession must never merge distinct
  // filesystem subjects.
  let normalized = value;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized.length === 0 ? '.' : normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
