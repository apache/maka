/**
 * Tests for validateHistoryCompactSummary — the structural gate that keeps a
 * degraded summarizer response from replacing folded history (#3029).
 *
 * Run: `npm --workspace @maka/runtime run test`
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  HISTORY_COMPACT_REQUIRED_SECTIONS,
  isHistoryCompactSummaryTruncated,
  validateHistoryCompactSummary,
} from '../history-compact-summary-validation.js';

const CONFORMING = [
  '## Goal',
  'Fix the compaction gate.',
  '',
  '## Progress',
  '### Done',
  '- Gate added.',
  '### In Progress',
  '- Tests.',
  '',
  '## Key Decisions',
  '- **Fail open**: never persist fragments.',
  '',
  '## Next Steps',
  '1. Review.',
  '',
  '## Critical Context',
  '- packages/runtime/src/mid-turn-capacity-compact.ts',
].join('\n');

describe('validateHistoryCompactSummary', () => {
  test('accepts a fully conforming summary', () => {
    assert.equal(validateHistoryCompactSummary(CONFORMING), undefined);
  });

  test('accepts a summary with only the required sections', () => {
    const thin = [
      '## Goal',
      'g',
      '',
      '## Progress',
      '### Done',
      '- d',
      '',
      '## Next Steps',
      '1. n',
    ].join('\n');
    assert.equal(validateHistoryCompactSummary(thin), undefined);
  });

  test('rejects the incident fragment verbatim (sections missing, tail truncated)', () => {
    // The exact summary persisted by checkpoint hcheckpoint-981ceab8…: the
    // pipeline accepted it and replaced 742 events / ~235k tokens (#3029).
    const incident =
      '确认服务端语义后，决定：`/goal pause|resume|clear` 走 `runControl`（写操作互斥），turn 中不可达但提示明确。现在看 desktop 的 retry 循环结尾：';
    assert.equal(validateHistoryCompactSummary(incident), 'missing_sections');
  });

  test('rejects raw tool-call markup instead of a summary', () => {
    // Observed live from a weak summarizer model that continued the
    // conversation instead of summarizing it (DeepSeek DSML output).
    const dsml =
      '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="Bash">\n<｜｜DSML｜｜parameter name="command" string="true">ls</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';
    assert.equal(validateHistoryCompactSummary(dsml), 'missing_sections');
  });

  test('rejects when a required section is missing', () => {
    for (const section of HISTORY_COMPACT_REQUIRED_SECTIONS) {
      const broken = CONFORMING.replace(section, section.replace('## ', '## Removed '));
      assert.equal(validateHistoryCompactSummary(broken), 'missing_sections', section);
    }
  });

  test('requires each section as its own heading line, not a prose mention', () => {
    const proseMention = [
      '## Goal',
      'Fix the gate.',
      '',
      '## Progress',
      'Done.',
      '',
      'The required headings are ## Goal, ## Progress, and ## Next Steps.',
    ].join('\n');
    assert.equal(validateHistoryCompactSummary(proseMention), 'missing_sections');
  });

  test('rejects a near-match heading like ## Goals for the ## Goal section', () => {
    const plural = CONFORMING.replace('## Goal\n', '## Goals\n');
    assert.equal(validateHistoryCompactSummary(plural), 'missing_sections');
  });

  test('rejects output that stops inside a code fence', () => {
    assert.equal(validateHistoryCompactSummary(CONFORMING + '\n\n```ts\nconst x = 1'), 'truncated');
  });

  test('rejects a summary ending on truncation punctuation', () => {
    // Representative sample of the tail class; the full char list lives next to
    // the regex so it stays co-located with the implementation it describes. A
    // backtick is deliberately absent: a trailing backtick also closes a fence.
    for (const tail of [':', '：', '…']) {
      assert.equal(validateHistoryCompactSummary(CONFORMING + ' ' + tail), 'truncated', tail);
    }
    // Sentence terminals are completion, not truncation, and must be accepted.
    assert.equal(validateHistoryCompactSummary(CONFORMING + '.'), undefined);
    assert.equal(validateHistoryCompactSummary(CONFORMING + '。'), undefined);
  });

  test('accepts a closed fence and terminal punctuation', () => {
    const withFence = CONFORMING + '\n\n```sh\nnpm test\n```\n\nDone.';
    assert.equal(validateHistoryCompactSummary(withFence), undefined);
  });
});

describe('isHistoryCompactSummaryTruncated', () => {
  test('rejects a truncated fragment and accepts a complete legacy summary without sections', () => {
    // Legacy summaries never carried the sectioned contract, so a section-less
    // summary is still loadable; only the truncation signal matters at load.
    assert.equal(isHistoryCompactSummaryTruncated('legacy summary without sections.'), false);
    assert.equal(isHistoryCompactSummaryTruncated('legacy summary cut off：'), true);
  });

  test('rejects output that stops inside a code fence even without sections', () => {
    assert.equal(isHistoryCompactSummaryTruncated('```ts\nconst x = 1'), true);
  });

  test('accepts a complete summary ending with a closed code fence', () => {
    // The trailing backtick closes the fence; the even fence count already
    // proves the block closed, so this is completion, not truncation.
    assert.equal(isHistoryCompactSummaryTruncated('```ts\nconst x = 1\n```'), false);
  });
});
