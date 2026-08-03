/**
 * Automation result preview contract (successor to the CronJob preview pin).
 *
 * The unified Automation tool returns human-readable TEXT, and the UI's
 * AutomationResultPreview parses that text into a friendly card (created /
 * deleted / listed). This contract feeds the REAL tool's output strings into
 * the REAL tool-detail renderer, so a runtime copy change that would silently
 * break the UI parsing (falling back to a raw text dump) fails here first.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutomationManager, buildAutomationTool, AUTOMATION_TOOL_NAME } from '@maka/runtime';
import { LocaleProvider, ToolCallDetail, type ToolActivityItem } from '@maka/ui';

const SESSION = 'sess-preview-contract';

function renderWithLocale(child: ReactNode): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'zh', children: child }),
  );
}

function toolCtx() {
  return {
    sessionId: SESSION,
    turnId: 'turn-1',
    cwd: '/tmp',
    toolCallId: 'tc-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function realTool() {
  let idc = 0;
  const manager = new AutomationManager({
    generateId: () => `auto-${++idc}`,
    now: () => 1_700_000_000_000,
    random: () => 0,
  });
  return buildAutomationTool({ automationManager: manager, cronEnabled: true });
}

function renderAutomationResult(text: string): string {
  const item: ToolActivityItem = {
    toolUseId: 'tu-1',
    toolName: AUTOMATION_TOOL_NAME,
    // This test exercises the result parser, not disclosure defaults; the
    // open prop mounts the panel in static markup.
    status: 'completed',
    args: { mode: 'create' },
    result: { kind: 'text', text },
  };
  return renderWithLocale(createElement(ToolCallDetail, { item: item }));
}

describe('Automation tool result preview contract', () => {
  it('renders a created card (not a raw text dump) for the real create output', async () => {
    const tool = realTool();
    const text = await tool.impl({
      mode: 'create', kind: 'cron', name: 'nightly report', prompt: 'write the report',
      schedule: { type: 'cron', expression: '0 3 * * *' },
    }, toolCtx()) as string;
    assert.ok(text.startsWith('Automation created:'), text);

    const markup = renderAutomationResult(text);
    assert.match(markup, /data-kind="automation_create"/);
    assert.match(markup, /自动化任务已创建/);
    assert.match(markup, /nightly report/);
    assert.doesNotMatch(markup, /data-kind="text"/, 'create result must not fall through to the raw text preview');
  });

  it('renders a deleted card for the real delete output', async () => {
    const tool = realTool();
    const created = await tool.impl({
      mode: 'create', kind: 'heartbeat', name: 'poll', prompt: 'p',
      schedule: { type: 'interval', seconds: 60 },
    }, toolCtx()) as string;
    const id = created.match(/^ID: (.+)$/m)?.[1];
    assert.ok(id, created);
    const text = await tool.impl({ mode: 'delete', id }, toolCtx()) as string;

    const markup = renderAutomationResult(text);
    assert.match(markup, /data-kind="automation_delete"/);
    assert.match(markup, /自动化任务已删除/);
    assert.doesNotMatch(markup, /data-kind="text"/);
  });

  it('renders a list card for the real list output (entries and empty)', async () => {
    const tool = realTool();
    await tool.impl({
      mode: 'create', kind: 'heartbeat', name: 'poll', prompt: 'p',
      schedule: { type: 'interval', seconds: 60 },
    }, toolCtx());
    const listText = await tool.impl({ mode: 'list' }, toolCtx()) as string;
    const markup = renderAutomationResult(listText);
    assert.match(markup, /data-kind="automation_list"/);
    assert.match(markup, /自动化任务列表 \(1\)/);
    assert.match(markup, /poll/);
    assert.doesNotMatch(markup, /data-kind="text"/);

    const emptyTool = realTool();
    const emptyText = await emptyTool.impl({ mode: 'list' }, toolCtx()) as string;
    const emptyMarkup = renderAutomationResult(emptyText);
    assert.match(emptyMarkup, /data-kind="automation_list"/);
    assert.match(emptyMarkup, /自动化任务列表 \(0\)/);
    assert.match(emptyMarkup, /当前会话暂无自动化任务/);
  });

  it('falls back to the bounded text preview for unrecognized shapes (errors, pause/resume)', async () => {
    const tool = realTool();
    const errText = await tool.impl({ mode: 'create' }, toolCtx()) as string; // missing fields → error text
    assert.ok(errText.startsWith('Error:'), errText);
    const markup = renderAutomationResult(errText);
    assert.match(markup, /data-kind="text"/, 'unrecognized automation text must use the generic bounded preview');
  });
});
