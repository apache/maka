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

import { buildDeepResearchImplementationPrompt } from './explore-agent.js';
import {
  DEEP_RESEARCH_CLIENT_IMPLEMENTATION_PROMPT_MAX_BYTES,
  DEEP_RESEARCH_CLIENT_OBJECTIVE_MAX_BYTES,
  DEEP_RESEARCH_CLIENT_PROGRESS_MAX_BYTES,
  DEEP_RESEARCH_CLIENT_RECENT_ITEMS_MAX,
  DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES,
  type DeepResearchClientProgress,
  type DeepResearchRun,
} from './deep-research-run.js';

/** Build the single bounded product projection used by local and hosted clients. */
export function projectDeepResearchClientProgress(
  run: DeepResearchRun,
): DeepResearchClientProgress {
  const blockers = [
    ...run.checklist.flatMap((item) =>
      item.blockedReason ? [labeledBlocker(item.title, item.blockedReason)] : [],
    ),
    ...run.steps.flatMap((step) =>
      step.blockedReason ? [labeledBlocker(step.objective, step.blockedReason)] : [],
    ),
  ];
  const base: DeepResearchClientProgress = {
    sessionId: run.sessionId,
    objective: truncateUtf8(run.objective, DEEP_RESEARCH_CLIENT_OBJECTIVE_MAX_BYTES),
    scopeLevel: run.scopeLevel,
    status: run.status,
    stage: run.stage,
    round: run.round,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    artifactsCount: run.artifacts.length,
    stepsCount: run.steps.length,
    checklist: run.checklist.map((item) => ({
      itemId: item.itemId,
      title: truncateUtf8(item.title, DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES),
      status: item.status,
      ...(item.blockedReason
        ? { blockedReason: truncateUtf8(item.blockedReason, DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES) }
        : {}),
    })),
    reportSections: run.reportSections.map(({ key, status }) => ({ key, status })),
    recentInspectedRefs: run.steps
      .flatMap((step) => step.inspectedRefs)
      .slice(-DEEP_RESEARCH_CLIENT_RECENT_ITEMS_MAX)
      .map((ref) => ({
        kind: ref.kind,
        locator: truncateUtf8(ref.locator, DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES),
        ...(ref.label
          ? { label: truncateUtf8(ref.label, DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES) }
          : {}),
      })),
    workerRunIds: [...new Set(run.steps.flatMap((step) => step.workerRunIds))].slice(
      -DEEP_RESEARCH_CLIENT_RECENT_ITEMS_MAX,
    ),
    blockers: [
      ...new Set(blockers.map((value) => truncateUtf8(value, DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES))),
    ].slice(-DEEP_RESEARCH_CLIENT_RECENT_ITEMS_MAX),
    ...(run.reportArtifactId ? { reportArtifactId: run.reportArtifactId } : {}),
  };
  if (encodedBytes(base) > DEEP_RESEARCH_CLIENT_PROGRESS_MAX_BYTES) {
    throw new Error('Deep Research client progress cannot fit its required fields');
  }
  if (run.status !== 'completed') return base;
  return fitImplementationPrompt(base, buildDeepResearchImplementationPrompt(run));
}

function labeledBlocker(label: string, reason: string): string {
  const separator = ': ';
  const reasonBudget = Math.floor(DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES * 0.75);
  const boundedReason = truncateUtf8(reason, reasonBudget);
  const titleBudget =
    DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES - utf8Bytes(separator) - utf8Bytes(boundedReason);
  return `${truncateUtf8(label, titleBudget)}${separator}${boundedReason}`;
}

function fitImplementationPrompt(
  base: DeepResearchClientProgress,
  prompt: string,
): DeepResearchClientProgress {
  const bounded = truncateUtf8(prompt, DEEP_RESEARCH_CLIENT_IMPLEMENTATION_PROMPT_MAX_BYTES);
  const full = { ...base, implementationPrompt: bounded };
  if (encodedBytes(full) <= DEEP_RESEARCH_CLIENT_PROGRESS_MAX_BYTES) return full;
  const characters = Array.from(bounded);
  let low = 1;
  let high = characters.length;
  let best = base;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = {
      ...base,
      implementationPrompt: truncateCharacters(bounded, midpoint),
    };
    if (encodedBytes(candidate) <= DEEP_RESEARCH_CLIENT_PROGRESS_MAX_BYTES) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

function truncateCharacters(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  if (maxCharacters === 1) return characters[0] ?? '…';
  return `${characters.slice(0, maxCharacters - 1).join('')}…`;
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const marker = '…';
  const markerBytes = encoder.encode(marker).byteLength;
  let bytes = 0;
  let output = '';
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes + markerBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return `${output}${marker}`;
}
