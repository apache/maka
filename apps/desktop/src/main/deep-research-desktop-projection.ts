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

import { projectDeepResearchClientProgress } from '@maka/core/deep-research-client-progress';
import { type DeepResearchClientProgress, type DeepResearchRun } from '@maka/core/deep-research-run';
import type { DeepResearchQueryResult } from '@maka/runtime-host/protocol';

export function projectEmbeddedDeepResearch(
  run: DeepResearchRun | undefined,
): DeepResearchClientProgress | undefined {
  return run ? projectDeepResearchClientProgress(run) : undefined;
}

export function projectHostedDeepResearch(
  result: DeepResearchQueryResult,
): DeepResearchClientProgress | undefined {
  if (result.kind === 'not_started') return undefined;
  return {
    sessionId: result.sessionId,
    objective: result.objective,
    scopeLevel: result.scopeLevel,
    status: result.status,
    stage: result.stage,
    round: result.round,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    artifactsCount: result.artifactsCount,
    stepsCount: result.stepsCount,
    checklist: result.checklist.map(({ itemId, title, status, blockedReason }) => ({
      itemId,
      title,
      status,
      ...(blockedReason === null ? {} : { blockedReason }),
    })),
    reportSections: result.reportSections.map(({ key, status }) => ({ key, status })),
    recentInspectedRefs: result.recentInspectedRefs.map(({ kind, locator, label }) => ({
      kind,
      locator,
      ...(label === null ? {} : { label }),
    })),
    workerRunIds: [...result.workerRunIds],
    blockers: [...result.blockers],
    ...(result.reportArtifactId === null ? {} : { reportArtifactId: result.reportArtifactId }),
    ...(result.implementationPrompt === null
      ? {}
      : { implementationPrompt: result.implementationPrompt }),
  };
}
