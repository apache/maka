import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import {
  presentWorkHubResultText,
  selectWorkHubResultText,
} from '@maka/core/workhub';

function assistant(turnId: string, text: string, sequence: number): StoredMessage {
  return {
    type: 'assistant',
    id: `assistant-${sequence}`,
    turnId,
    ts: sequence,
    text,
    modelId: 'test-model',
  };
}

test('WorkHub projects only the final non-empty assistant result after tool steps', () => {
  const transcript: StoredMessage[] = [
    assistant('turn-1', '我先了解一下项目结构', 1),
    assistant('turn-1', '', 2),
    assistant('turn-1', '\n\n', 3),
    assistant('other-turn', '另一个 Turn 的回答', 4),
    assistant('turn-1', '## 结论\n\n最终结果只保留这一段。\n', 5),
  ];

  assert.equal(
    selectWorkHubResultText(transcript, 'turn-1'),
    '## 结论\n\n最终结果只保留这一段。',
  );
});

test('legacy aggregated WorkHub detail drops tool narration separated by large blank runs', () => {
  const legacy = [
    '我先了解一下项目结构。',
    '',
    '接下来查看相关文件。',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    '## 结论先行',
    '',
    '这里只保留最终结果。',
  ].join('\n');

  assert.equal(
    presentWorkHubResultText(legacy),
    '## 结论先行\n\n这里只保留最终结果。',
  );
});

test('normal final answers preserve intentional Markdown paragraph spacing', () => {
  assert.equal(
    presentWorkHubResultText('第一段。\n\n第二段。\n\n- 项目一\n- 项目二'),
    '第一段。\n\n第二段。\n\n- 项目一\n- 项目二',
  );
});
