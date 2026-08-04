import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeepResearchClientProgress } from '@maka/core';
import { DeepResearchEmptyHero } from '../chat-empty-hero.js';
import { DeepResearchProgressPanel } from '../chat-view.js';
import { getConversationCopy } from '../conversation-copy.js';
import { LocaleProvider } from '../locale-context.js';

function completedRun(): DeepResearchClientProgress {
  return {
    sessionId: 'session-1',
    objective: 'Verify the progress UI.',
    scopeLevel: 'standard',
    status: 'completed',
    stage: 'completed',
    round: 2,
    createdAt: 1,
    updatedAt: 2,
    artifactsCount: 0,
    stepsCount: 1,
    checklist: [{
      itemId: 'project_entrypoints',
      title: 'Map project entrypoints',
      status: 'completed',
    }],
    recentInspectedRefs: [{ kind: 'symbol', locator: 'DeepResearchProgressPanel' }],
    workerRunIds: ['worker-1'],
    blockers: [],
    reportSections: [
      { key: 'conclusion', status: 'completed' },
      { key: 'source_evidence', status: 'completed' },
      { key: 'borrow_diverge_risk_gate', status: 'completed' },
      { key: 'implementation_recommendations', status: 'completed' },
      { key: 'verification', status: 'completed' },
    ],
    reportArtifactId: 'report-1',
    implementationPrompt: 'Implement the approved slice.',
  };
}

describe('DeepResearchProgressPanel', () => {
  it('renders inspectable progress and an explicit normal-task handoff action', () => {
    const markup = renderToStaticMarkup(
      <DeepResearchProgressPanel run={completedRun()} onContinue={() => undefined} />,
    );

    assert.match(markup, /研究完成 · 原会话保持只读/);
    assert.match(markup, /Map project entrypoints/);
    assert.match(markup, /DeepResearchProgressPanel/);
    assert.match(markup, /Workers: worker-1/);
    assert.match(markup, /取舍与风险/);
    assert.match(markup, /在新任务中继续实现/);
    assert.match(markup, /不会自动发送，也不会改变原研究会话权限/);
  });

  it('does not expose the implementation action before completion', () => {
    const run = completedRun();
    const markup = renderToStaticMarkup(
      <DeepResearchProgressPanel
        run={{ ...run, status: 'active', stage: 'report_writing', implementationPrompt: undefined }}
        onContinue={() => undefined}
      />,
    );

    assert.doesNotMatch(markup, /在新任务中继续实现/);
    assert.match(markup, /report_writing/);
  });

  it('renders the progress surface from the selected locale catalog', () => {
    const markup = renderToStaticMarkup(
      <DeepResearchProgressPanel
        run={completedRun()}
        copy={getConversationCopy('en').chat.deepResearchProgress}
      />,
    );

    assert.match(markup, /Research complete · Original session remains read-only/);
    assert.match(markup, /Tradeoffs and risks/);
    assert.doesNotMatch(markup, /研究完成|取舍与风险/);
  });
});

describe('DeepResearchEmptyHero', () => {
  it('exposes each starter label and prompt as one clickable item name', () => {
    const copy = getConversationCopy('en').deepResearchEmpty;
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <DeepResearchEmptyHero onPromptSuggestion={() => undefined} />
      </LocaleProvider>,
    );

    const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    for (const suggestion of copy.starters) {
      const promptPreview = suggestion.prompt.slice(0, 60);
      const button = buttons.find((candidate) =>
        candidate.includes(suggestion.label) && candidate.includes(promptPreview)
      ) ?? '';
      assert.notEqual(button, '', `missing accessible starter for ${suggestion.label}`);
      assert.doesNotMatch(button, /aria-label=/, 'visible label and description must own the accessible name');
    }
  });
});
