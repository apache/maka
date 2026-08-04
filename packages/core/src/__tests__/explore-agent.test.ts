import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_CHARS,
  DEEP_RESEARCH_SESSION_LABEL,
  buildDeepResearchImplementationPrompt,
  buildDeepResearchSystemPromptFragment,
  isDeepResearchSession,
} from '../explore-agent.js';
import type { DeepResearchRun } from '../deep-research-run.js';
import { createGenesisExecutionBoundary } from '../sandbox-boundary.js';

describe('deep research session profile', () => {
  it('detects only the stable session label', () => {
    assert.equal(isDeepResearchSession([DEEP_RESEARCH_SESSION_LABEL]), true);
    for (const labels of [['research'], [], undefined]) {
      assert.equal(isDeepResearchSession(labels), false);
    }
  });

  it('builds a bounded handoff only from a completed run', () => {
    const run = {
      schemaVersion: 1,
      sessionId: 'session-research',
      objective: 'Improve Deep Research.',
      scopeLevel: 'standard',
      status: 'completed',
      stage: 'completed',
      round: 2,
      createdAt: 1,
      updatedAt: 2,
      artifacts: [],
      checklist: [],
      steps: [],
      reportSections: [],
      checkpoints: [],
      reportArtifactId: 'report-1',
      handoff: {
        artifactId: 'handoff-1',
        implementationTasks: ['Add an explicit transition.'],
        recommendedIssues: ['Track visual verification.'],
        recommendedPullRequests: [],
        verificationCommands: ['npm test'],
      },
      completedAt: 2,
    } satisfies DeepResearchRun;

    const prompt = buildDeepResearchImplementationPrompt(run);
    assert.match(prompt, /original research session remains read-only/i);
    assert.match(prompt, /present an implementation plan before changing project files/i);
    assert.match(prompt, /Add an explicit transition/);
    assert.match(prompt, /Final report artifact: report-1/);
    assert.ok(Array.from(prompt).length <= DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_CHARS);
    assert.throws(
      () =>
        buildDeepResearchImplementationPrompt({
          ...run,
          status: 'active',
          stage: 'knowledge_base',
        }),
      /requires a completed run/,
    );
  });

  it('gives explore sessions a managed read-only filesystem and restricted network', () => {
    const boundary = createGenesisExecutionBoundary('explore');
    assert.equal(boundary.kind, 'managed');
    if (boundary.kind !== 'managed') return;
    assert.equal(boundary.profile.name, 'read-only');
    assert.deepEqual(boundary.profile.fileSystem, {
      kind: 'restricted',
      entries: [{ kind: 'special', access: 'read', special: ':workspace_roots' }],
    });
    assert.equal(boundary.profile.network.kind, 'restricted');
  });

  it('keeps the system prompt source-grounded, read-only, and explicit about its write exception', () => {
    const prompt = buildDeepResearchSystemPromptFragment();
    for (const contract of [
      /Read, Glob, Grep/,
      /Do not write/,
      /deep_research_\* tools are the one write exception/,
      /archive each important raw source first/,
      /all five report sections are completed/,
      /role=handoff artifact/,
      /borrow \/ diverge \/ risk \/ gate/,
    ]) {
      assert.match(prompt, contract);
    }
  });
});
