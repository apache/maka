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

import { createHash } from 'node:crypto';
import type { TaskMutationCorrelation, TaskMutationLookup } from '@maka/runtime-host/protocol';
import type { MakaSessionDriver } from './session-driver.js';
import type {
  MakaPiTaskMutationState,
  MakaPiToolEntry,
  MakaPiTranscriptState,
} from './pi-transcript.js';

interface TaskMutationTarget {
  readonly entry: MakaPiToolEntry;
  readonly correlation: TaskMutationCorrelation;
  readonly operation: 'create' | 'update';
  readonly observedSettled: boolean;
}

export interface TaskMutationHydrationController {
  /** Invalidates old requests before the transcript entry identities are replaced. */
  replace(sessionId: string | null): void;
  /** Hydrates every current Task mutation entry through one atomic UI commit. */
  schedule(sessionId: string | null): void;
  dispose(): void;
}

export function createTaskMutationHydrationController(input: {
  readonly state: MakaPiTranscriptState;
  readonly driver: Pick<MakaSessionDriver, 'queryTaskMutations'>;
  readonly onChanged: () => void;
}): TaskMutationHydrationController {
  let sessionId: string | null = null;
  let transcriptGeneration = 0;
  let requestGeneration = 0;
  let disposed = false;
  const announced = new Set<string>();

  const replace = (nextSessionId: string | null): void => {
    transcriptGeneration += 1;
    requestGeneration += 1;
    if (nextSessionId !== sessionId) announced.clear();
    sessionId = nextSessionId;
  };

  const schedule = (requestedSessionId: string | null): void => {
    if (disposed || !requestedSessionId || requestedSessionId !== sessionId) return;
    if (!input.driver.queryTaskMutations) return;
    const targets = taskMutationTargets(input.state);
    if (targets.length === 0) return;
    const capturedTranscriptGeneration = transcriptGeneration;
    const capturedRequestGeneration = ++requestGeneration;
    void input.driver
      .queryTaskMutations(
        requestedSessionId,
        targets.map(({ correlation }) => correlation),
      )
      .then((lookups) => {
        if (
          disposed ||
          sessionId !== requestedSessionId ||
          transcriptGeneration !== capturedTranscriptGeneration ||
          requestGeneration !== capturedRequestGeneration ||
          lookups.length !== targets.length
        ) {
          return;
        }
        const entries = new Set(input.state.entries);
        for (let index = 0; index < targets.length; index += 1) {
          const target = targets[index]!;
          const lookup = lookups[index]!;
          if (
            !entries.has(target.entry) ||
            correlationKey(target.correlation) !== correlationKey(lookup.correlation) ||
            (lookup.kind === 'found' && lookup.presentation.operation !== target.operation)
          ) {
            return;
          }
        }

        let changed = false;
        let frozenFoundChanged = false;
        for (let index = 0; index < targets.length; index += 1) {
          const target = targets[index]!;
          const lookup = lookups[index]!;
          const next = mutationState(lookup, target.observedSettled);
          const previous = target.entry.taskMutation;
          if (previous?.fingerprint === next.fingerprint) continue;
          target.entry.taskMutation = next;
          target.entry.taskMutationVersion = (target.entry.taskMutationVersion ?? 0) + 1;
          changed = true;
          if (
            next.kind !== 'found' ||
            previous?.kind === 'found' ||
            !isFrozenRenderedEntry(input.state, target.entry)
          ) {
            continue;
          }
          const noticeKey = `${requestedSessionId}\0${correlationKey(target.correlation)}\0${next.fingerprint}`;
          if (announced.has(noticeKey)) continue;
          announced.add(noticeKey);
          frozenFoundChanged = true;
        }
        if (frozenFoundChanged) {
          input.state.entries.push({
            kind: 'notice',
            level: 'info',
            text: 'Task details are ready · /transcript to view the full history.',
          });
        }
        if (changed || frozenFoundChanged) input.onChanged();
      })
      .catch(() => undefined);
  };

  return {
    replace,
    schedule,
    dispose: () => {
      disposed = true;
      transcriptGeneration += 1;
      requestGeneration += 1;
      announced.clear();
      sessionId = null;
    },
  };
}

function taskMutationTargets(state: MakaPiTranscriptState): TaskMutationTarget[] {
  const targets: TaskMutationTarget[] = [];
  const seen = new Set<string>();
  for (const entry of state.entries) {
    if (
      entry.kind !== 'tool' ||
      !entry.turnId ||
      (entry.toolName !== 'task_create' && entry.toolName !== 'task_update') ||
      entry.userOwned === true ||
      entry.suppressed === true ||
      entry.taskMutation?.kind === 'found'
    ) {
      continue;
    }
    const correlation = { turnId: entry.turnId, toolCallId: entry.toolUseId };
    const key = correlationKey(correlation);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      entry,
      correlation,
      operation: entry.toolName === 'task_create' ? 'create' : 'update',
      observedSettled: entry.callStatus !== 'running',
    });
  }
  return targets;
}

function mutationState(
  lookup: TaskMutationLookup,
  observedSettled: boolean,
): MakaPiTaskMutationState {
  if (lookup.kind === 'found') {
    return {
      kind: 'found',
      presentation: structuredClone(lookup.presentation),
      fingerprint: fingerprint(lookup),
    };
  }
  return {
    kind: 'unresolved',
    reason: lookup.kind,
    observedSettled,
    fingerprint: fingerprint({ ...lookup, observedSettled }),
  };
}

function isFrozenRenderedEntry(state: MakaPiTranscriptState, entry: MakaPiToolEntry): boolean {
  const firstLine = state.renderGeometry.entryFirstLine?.get(entry);
  const lineCount = state.renderGeometry.entryLineCount?.get(entry);
  return (
    firstLine !== undefined &&
    lineCount !== undefined &&
    firstLine < state.renderGeometry.viewportTop &&
    (lineCount === 0 || firstLine + lineCount <= state.renderGeometry.viewportTop)
  );
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function correlationKey(correlation: TaskMutationCorrelation): string {
  return JSON.stringify([correlation.turnId, correlation.toolCallId]);
}
