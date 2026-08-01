import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { resumeParkToastCopy } from '../runtime-resume-copy.js';

describe('resumeParkToastCopy', () => {
  it('explains that a session with no candidate is already current', () => {
    const copy = resumeParkToastCopy(['resume_candidate_missing']);

    assert.deepEqual(copy, {
      title: '没有可恢复的对话',
      description: '会话已是最新状态。',
    });
    assert.doesNotMatch(`${copy.title} ${copy.description}`, /resume_candidate_missing/);
  });

  it('turns a dangling tool state into actionable user-facing copy', () => {
    const copy = resumeParkToastCopy(['dangling_tool_state']);

    assert.equal(copy.title, '暂时无法安全恢复');
    assert.match(copy.description, /工具执行中断/);
    assert.doesNotMatch(copy.description, /dangling_tool_state/);
  });

  it('does not leak an unknown internal reason code', () => {
    const copy = resumeParkToastCopy(['future_internal_reason']);

    assert.equal(copy.title, '暂时无法安全恢复');
    assert.equal(copy.description, '当前会话不满足安全恢复条件。');
    assert.doesNotMatch(copy.description, /future_internal_reason/);
  });

  it('explains immutable lineage failures without exposing machine codes', () => {
    const copy = resumeParkToastCopy([
      'runtime_lineage_start_mismatch',
      'source_prefix_digest_mismatch',
    ]);

    assert.deepEqual(copy, {
      title: '暂时无法安全恢复',
      description: '续跑链的起点记录不一致，已停止恢复。 上次运行的不可变边界已发生变化。',
    });
  });
});
