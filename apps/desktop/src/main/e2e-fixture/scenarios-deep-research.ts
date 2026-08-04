import {
  DEEP_RESEARCH_DEFAULT_CHECKLIST,
  DEEP_RESEARCH_REPORT_SECTION_KEYS,
} from '@maka/core';
import type { SessionHeader, StoredMessage } from '@maka/core';
import { createSqliteDeepResearchStore } from '@maka/storage';
import { header } from './seed-helpers.js';

export const DEEP_RESEARCH_SESSION_ID = 'e2e-fixture-deep-research';

export function deepResearchSession(now: number): SessionHeader {
  return {
    ...header({
      id: DEEP_RESEARCH_SESSION_ID,
      name: '深度研究：文件系统式长期研究',
      connection: 'zai-live',
      model: 'glm-5.1',
      now,
      lastMessageAt: now - 2 * 60_000,
    }),
    labels: ['mode:deep_research'],
    permissionMode: 'explore',
  };
}

export function deepResearchMessages(now: number): StoredMessage[] {
  const turnId = 'deep-research-turn-1';
  return [
    {
      type: 'user',
      id: 'deep-research-user-1',
      turnId,
      ts: now - 4 * 60_000,
      text: '调研文件系统式 Deep Research，并给出可实施的 Maka 方案。',
    },
    {
      type: 'assistant',
      id: 'deep-research-assistant-1',
      turnId,
      ts: now - 2 * 60_000,
      text: '研究已完成，证据、报告和实施 handoff 已保存。原研究会话继续保持只读。',
      modelId: 'glm-5.1',
    },
  ];
}

export async function writeDeepResearchLedger(workspaceRoot: string, now: number): Promise<void> {
  let eventNumber = 0;
  const store = createSqliteDeepResearchStore(workspaceRoot, {
    newId: () => `deep-research-event-${++eventNumber}`,
    now: () => now,
  });
  const hash = `sha256:${'a'.repeat(64)}`;
  const sourceArtifactId = 'source-paper';
  try {
    await store.start(
      DEEP_RESEARCH_SESSION_ID,
      'Reproduce a durable filesystem-backed Deep Research workflow in Maka.',
      'standard',
    );
    await store.recordArtifact(DEEP_RESEARCH_SESSION_ID, {
      artifactId: sourceArtifactId,
      role: 'source',
      name: 'fs-researcher-paper.md',
      createdAt: now - 19 * 60_000,
      locator: 'https://arxiv.org/abs/2602.01566',
      contentHash: hash,
      sourceArtifactIds: [],
    });
    for (const [index, key] of DEEP_RESEARCH_REPORT_SECTION_KEYS.entries()) {
      await store.recordArtifact(DEEP_RESEARCH_SESSION_ID, {
        artifactId: `section-${key}`,
        role: 'report_section',
        name: `${key}.md`,
        createdAt: now - (14 - index) * 60_000,
        contentHash: hash,
        sourceArtifactIds: [sourceArtifactId],
        reportSectionKey: key,
        reportSectionStatus: 'completed',
      });
    }
    await store.recordStep(DEEP_RESEARCH_SESSION_ID, {
      kind: 'local_exploration',
      status: 'completed',
      objective: 'Trace the durable workspace from runtime tools to Desktop UI.',
      summary: 'The event ledger, Artifact Store, IPC, and progress surface are connected.',
      roots: ['packages/core', 'packages/storage', 'packages/runtime', 'apps/desktop'],
      keywords: ['deepResearchStore', 'DeepResearchProgressPanel'],
      ignoredPaths: ['dist', 'node_modules'],
      stoppingCondition: 'Stop after storage authority and renderer projection are verified.',
      expectedEvidence: 'Concrete files, symbols, tests, and a source-backed artifact.',
      evidenceArtifactIds: [sourceArtifactId],
      inspectedRefs: [
        { kind: 'file', locator: 'packages/storage/src/deep-research-store.ts' },
        { kind: 'symbol', locator: 'DeepResearchProgressPanel' },
        { kind: 'test', locator: 'packages/runtime/src/__tests__/deep-research-tools.test.ts' },
      ],
      workerRunIds: ['worker-paper-review', 'worker-runtime-audit'],
    });
    for (const item of DEEP_RESEARCH_DEFAULT_CHECKLIST) {
      await store.updateChecklist(DEEP_RESEARCH_SESSION_ID, {
        itemId: item.itemId,
        status: 'completed',
        evidenceArtifactIds: [sourceArtifactId],
      });
    }
    await store.recordCheckpoint(DEEP_RESEARCH_SESSION_ID, {
      round: 2,
      stage: 'report_writing',
      status: 'active',
      summary: 'Evidence is complete and the implementation handoff is ready.',
      openQuestions: [],
      nextSteps: ['Review the handoff before entering implementation mode.'],
      taskIds: [],
      artifactIds: [sourceArtifactId],
    });
    await store.recordArtifact(DEEP_RESEARCH_SESSION_ID, {
      artifactId: 'report-final',
      role: 'report',
      name: 'deep-research-report.md',
      createdAt: now - 5 * 60_000,
      contentHash: hash,
      sourceArtifactIds: [sourceArtifactId],
    });
    await store.recordArtifact(DEEP_RESEARCH_SESSION_ID, {
      artifactId: 'handoff-final',
      role: 'handoff',
      name: 'implementation-handoff.md',
      createdAt: now - 4 * 60_000,
      contentHash: hash,
      sourceArtifactIds: [sourceArtifactId],
    });
    await store.complete(DEEP_RESEARCH_SESSION_ID, 'report-final', {
      artifactId: 'handoff-final',
      implementationTasks: ['Harden resume semantics.', 'Ship the visible progress surface.'],
      recommendedIssues: ['Track cross-platform durability failures separately.'],
      recommendedPullRequests: ['Land the workspace foundation before autonomous search policy.'],
      verificationCommands: ['npm run typecheck', 'npm test'],
    });
  } finally {
    store.close();
  }
}
