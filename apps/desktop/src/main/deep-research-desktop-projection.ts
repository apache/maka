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
