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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  formatAsKeyValueLines,
  formatQuietJsonValue,
  formatToolInvocationLine,
  projectToolArgsPreview,
} from '../tool-quiet-preview.js';
import { projectToolActivityArgs } from '../tool-activity-args.js';

describe('tool quiet preview', () => {
  it('redacts secrets in values and embedded keys', () => {
    const value = formatQuietJsonValue({ password: 'correct-horse', ok: true }, 'en').body;
    assert.doesNotMatch(value, /correct-horse/);
    assert.match(value, /redacted/i);
    const key = formatAsKeyValueLines({ 'password=secret': true }, 0, 'en');
    assert.doesNotMatch(key, /secret/);
    assert.match(key, /redacted/i);
  });
});

describe('formatToolInvocationLine', () => {
  it('names a Bash call by its command', () => {
    const line = formatToolInvocationLine(
      { toolName: 'Bash', args: { command: 'git status --porcelain' } },
      'en',
    );
    assert.equal(line, 'git status --porcelain');
  });

  it('names a GoalSet call by its condition', () => {
    const line = formatToolInvocationLine(
      { toolName: 'GoalSet', args: { condition: 'all tests in packages/runtime pass' } },
      'en',
    );
    assert.equal(line, 'all tests in packages/runtime pass');
  });

  it('names an AskUserQuestion call by its first question with a count suffix', () => {
    const line = formatToolInvocationLine(
      {
        toolName: 'AskUserQuestion',
        args: {
          questions: [
            { question: '选哪个方案?', options: [{ label: 'A' }, { label: 'B' }] },
            { question: '继续吗?', options: [{ label: '是' }, { label: '否' }] },
          ],
        },
      },
      'zh',
    );
    assert.equal(line, '选哪个方案? 等 2 问');
  });

  it('keeps the ScheduledTask title headline', () => {
    const line = formatToolInvocationLine(
      {
        toolName: 'ScheduledTask',
        args: { title: '每天 9:00 生成日报', schedule: { kind: 'cron' } },
      },
      'zh',
    );
    assert.equal(line, '每天 9:00 生成日报');
  });
});

describe('projectToolArgsPreview', () => {
  it('keeps only the formatter-readable fields, shaped like the args', () => {
    const preview = projectToolArgsPreview('Write', {
      path: 'packages/ui/src/tool-activity.tsx',
      content: 'a very large file body that must never reach the wire',
    });
    assert.deepEqual(preview, { path: 'packages/ui/src/tool-activity.tsx' });
  });

  it('redacts secrets embedded in command strings', () => {
    const preview = projectToolArgsPreview('Bash', {
      command: 'curl -H "Authorization: Bearer super-secret-token-value" https://example.com',
    });
    const serialized = JSON.stringify(preview);
    assert.doesNotMatch(serialized, /super-secret-token-value/);
    assert.match(serialized, /redacted/i);
  });

  it('drops sensitive keys entirely', () => {
    const preview = projectToolArgsPreview('SomeTool', {
      title: 'hello',
      password: 'hunter2',
      api_key: 'abcdef',
    });
    assert.deepEqual(preview, { title: 'hello' });
  });

  it('does not put generic input payloads on the live wire', () => {
    assert.equal(
      projectToolArgsPreview('third_party_tool', {
        input: 'short private body',
        inputPreview: { text: 'forged private body', bytes: 19, truncated: false },
        size: { cols: 80, rows: 24 },
      }),
      undefined,
    );
  });

  it('names deep research starts from their bounded objective preview', () => {
    const preview = projectToolArgsPreview('deep_research_start', {
      objective: 'Inspect the runtime host boundary',
      scope_level: 'standard',
      artifact_content: 'must not reach the live wire',
    });
    assert.deepEqual(preview, {
      objective: 'Inspect the runtime host boundary',
      scope_level: 'standard',
    });
    assert.equal(
      formatToolInvocationLine({ toolName: 'deep_research_start', args: preview }, 'en'),
      'Inspect the runtime host boundary (standard)',
    );
  });

  it('bounds long values and whole-preview size', () => {
    const preview = projectToolArgsPreview('Bash', { command: 'x'.repeat(5000) });
    const command = (preview as { command: string }).command;
    assert.ok(command.length <= 240, `expected <=240 chars, got ${command.length}`);
    assert.ok(command.endsWith('…'));
    assert.ok(JSON.stringify(preview).length <= 2048);
  });

  it('excludes Task Ledger tools until their durable semantic projection owns identity', () => {
    assert.equal(projectToolArgsPreview('task_create', { tasks: [{ subject: 'one' }] }), undefined);
    assert.equal(
      projectToolArgsPreview('task_update', { id: 'T1', status: 'completed' }),
      undefined,
    );
    assert.equal(projectToolArgsPreview('task_list', { status: 'pending' }), undefined);
    assert.equal(projectToolArgsPreview('task_get', { id: 'T1' }), undefined);
  });

  it('does not accept forged question payloads from third-party tools', () => {
    assert.equal(
      projectToolArgsPreview('third_party_tool', {
        questions: [{ question: 'private body' }],
      }),
      undefined,
    );
  });

  it('preserves the WriteStdin projected inputPreview shape', () => {
    const projected = projectToolActivityArgs('WriteStdin', {
      ref: 'maka://runtime/background-tasks/1',
      input: 'ls -la\n',
      size: { cols: 80, rows: 24 },
    });
    const preview = projectToolArgsPreview('WriteStdin', projected);
    const line = formatToolInvocationLine({ toolName: 'WriteStdin', args: preview }, 'zh');
    assert.ok(line !== undefined);
    assert.match(line, /后台终端交互/);
    assert.match(line, /80x24/);
  });

  it('returns undefined when nothing displayable exists', () => {
    assert.equal(projectToolArgsPreview('Bash', {}), undefined);
    assert.equal(projectToolArgsPreview('Bash', undefined), undefined);
    assert.equal(projectToolArgsPreview('Bash', { content: 'not a headline field' }), undefined);
  });
});
