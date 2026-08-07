import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider, ToolCallDetail, type ToolActivityItem } from '@maka/ui';

describe('subagent UI contract', () => {
  it('renders a compact subagent card without exposing internal ids', () => {
    const item: ToolActivityItem = {
      toolUseId: 'subagent',
      toolName: 'Subagent',
      status: 'completed',
      args: {},
      result: {
        kind: 'subagent',
        agentName: 'Research Agent',
        turnId: 'turn-secret-123',
        runId: 'run-secret-456',
        status: 'completed',
        permissionMode: 'explore',
        summary: 'Mapped the runtime path.',
        artifactIds: ['artifact-secret-1', 'artifact-secret-2'],
        durationMs: 14_500,
        eventCount: 42,
      },
    };
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(ToolCallDetail, { item: item }),
    }));

    assert.match(markup, /data-kind="subagent"/);
    assert.match(markup, /Research Agent/);
    assert.match(markup, /已完成/);
    assert.match(markup, /只读/);
    assert.match(markup, /耗时/);
    assert.match(markup, /Mapped the runtime path\./);
    assert.match(markup, /产物/);
    assert.match(markup, /2 个/);

    assert.doesNotMatch(markup, /turn-secret-123/);
    assert.doesNotMatch(markup, /run-secret-456/);
    assert.doesNotMatch(markup, /artifact-secret-1/);
    assert.doesNotMatch(markup, /artifact-secret-2/);
    assert.doesNotMatch(markup, />Close</);
    assert.doesNotMatch(markup, />explore</);
    assert.doesNotMatch(markup, /事件/);
    assert.doesNotMatch(markup, /42 个事件/);
  });

  it('forwards onOpenLinkedSession through ToolCallDetail when childSessionId is present', () => {
    const item: ToolActivityItem = {
      toolUseId: 'subagent-open',
      toolName: 'spawn_subagent',
      status: 'completed',
      args: {},
      result: {
        kind: 'subagent',
        agentName: 'Explore layout',
        turnId: 'turn-open',
        runId: 'run-open',
        childSessionId: 'child-session-open',
        status: 'completed',
        permissionMode: 'explore',
        summary: 'Mapped the layout.',
        artifactIds: [],
        durationMs: 1_200,
        eventCount: 4,
      },
    };
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(ToolCallDetail, {
        item,
        onOpenLinkedSession() {},
      }),
    }));

    assert.match(markup, /data-kind="subagent"/);
    assert.match(markup, /打开会话|Open session/);
    assert.match(markup, /child-session-open|Explore layout/);
  });

  it('hides the open control when onOpenLinkedSession is not provided', () => {
    const item: ToolActivityItem = {
      toolUseId: 'subagent-no-host',
      toolName: 'spawn_subagent',
      status: 'completed',
      args: {},
      result: {
        kind: 'subagent',
        agentName: 'No host open',
        turnId: 'turn-no-host',
        runId: 'run-no-host',
        childSessionId: 'child-session-no-host',
        status: 'completed',
        permissionMode: 'explore',
        summary: 'Ready.',
        artifactIds: [],
        durationMs: 800,
        eventCount: 2,
      },
    };
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(ToolCallDetail, { item }),
    }));

    assert.match(markup, /data-kind="subagent"/);
    assert.doesNotMatch(markup, /打开会话|Open session/);
  });

});
