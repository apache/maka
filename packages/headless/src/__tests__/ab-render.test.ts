import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderAbComparisonMarkdown } from '../ab-render.js';
import { summarizeAbComparison } from '../ab-summary.js';
import {
  budgetExhausted,
  completed,
  contextBudgetSummary,
  withTrace,
} from './helpers/ab-summary-fixtures.js';

describe('renderAbComparisonMarkdown', () => {
  test('renders the comparison decision and core outcome measures', () => {
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'maka-baseline',
      candidateArmId: 'candidate',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [
        [completed('t1', false), completed('t2', false)],
        [completed('t1', false), completed('t2', true)],
      ],
      candidateRuns: [
        [completed('t1', true), completed('t2', true)],
        [completed('t1', true), completed('t2', true)],
      ],
      budgetMs: 600_000,
    });

    const markdown = renderAbComparisonMarkdown(result);

    assert.match(
      markdown,
      /Decision: not cleared \(non_inferiority_confidence_interval_crosses_margin\)/,
    );
    assert.match(markdown, /Budget: 600s task budget/);
    assert.match(markdown, /Outcome pass rate: A=1\/4 = 0.25, B=4\/4 = 1/);
    assert.match(markdown, /Task-level delta: mean=0.75/);
    assert.doesNotMatch(markdown, /held-in|held-out|keep|discard|acceptance/i);
  });

  test('renders investigation refs for changed outcomes and activated policies', () => {
    const activatedSummary = contextBudgetSummary({
      activePrunedToolResults: 1,
      activeEstimatedTokensSaved: 50,
    });
    const result = summarizeAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselineArmId: 'prune-off',
      candidateArmId: 'active-prune-on',
      evaluationTaskIds: ['b-loss', 'activated', 'budget'],
      baselineRuns: [
        [
          withTrace(completed('b-loss', true), 'A', 'b-loss'),
          withTrace(completed('activated', true), 'A', 'activated'),
          withTrace(completed('budget', true), 'A', 'budget'),
        ],
      ],
      candidateRuns: [
        [
          withTrace(completed('b-loss', false), 'B', 'b-loss'),
          {
            ...withTrace(completed('activated', true), 'B', 'activated'),
            id: 'event-B-activated-r0',
            contextBudgetSummary: activatedSummary,
          },
          {
            ...budgetExhausted('budget'),
            id: 'event-B-budget-r0',
            roundId: 'ab-prune-on-r0-budget',
          },
        ],
      ],
    });

    const markdown = renderAbComparisonMarkdown(result);

    assert.match(markdown, /Activated Attempts/);
    assert.match(markdown, /event-B-activated-r0.*\/traces\/B\/activated\/events\.jsonl/);
    assert.match(markdown, /B Loss Refs/);
    assert.match(markdown, /b-loss#r0.*\/logs\/B\/b-loss\/runtime-events\.jsonl/);
    assert.match(markdown, /Budget Discordant Refs/);
    assert.match(markdown, /budget#r0.*runtime_unavailable=budget_exhausted_before_cell_output/);
  });
});
