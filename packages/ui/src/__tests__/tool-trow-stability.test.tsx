import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import type { ToolActivityItem } from '../materialize.js';
import { ToolTrow } from '../tool-activity.js';

function runningTool(id: string, name: string): ToolActivityItem {
  return { toolUseId: id, toolName: name, status: 'running', args: {} };
}

function subagent(childSessionId?: string): ToolActivityItem {
  return {
    toolUseId: 'spawn-1',
    toolName: 'agent_spawn',
    status: 'running',
    args: { task: 'Inspect the runtime' },
    intent: 'Inspect the runtime',
    result: {
      kind: 'subagent',
      ...(childSessionId ? { childSessionId } : {}),
      agentName: 'Local Read',
      turnId: 'turn-1',
      status: 'running',
      permissionMode: 'explore',
      summary: '',
      artifactIds: [],
    },
  };
}

function renderToStaticMarkup(node: ReactNode): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: node,
  }));
}

describe('ToolTrow stable structure', () => {
  it('renders addition and deletion counts for a file_diff result', () => {
    const item: ToolActivityItem = {
      toolUseId: 'tool-1',
      toolName: 'Edit',
      status: 'completed',
      args: { path: 'a.ts' },
      result: {
        kind: 'file_diff',
        paths: ['a.ts'],
        diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more',
      },
    };

    const html = renderToStaticMarkup(createElement(ToolTrow, { items: [item] }));

    assert.match(html, />\+2</);
    assert.match(html, />-1</);
  });

  it('omits a zero count instead of painting -0 on a pure-additions write', () => {
    const item: ToolActivityItem = {
      toolUseId: 'tool-1',
      toolName: 'Write',
      status: 'completed',
      args: { path: 'new.md' },
      result: {
        kind: 'file_diff',
        paths: ['new.md'],
        diff: '--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,2 @@\n+alpha\n+beta',
      },
    };

    const html = renderToStaticMarkup(createElement(ToolTrow, { items: [item] }));

    assert.match(html, />\+2</);
    assert.doesNotMatch(html, />-0</);
  });

  it('leaves the collapsed group header alone when the run changed no file', () => {
    const html = renderToStaticMarkup(createElement(ToolTrow, {
      items: [runningTool('tool-1', 'Read'), runningTool('tool-2', 'Grep')],
    }));

    assert.doesNotMatch(html, />\+0</);
    assert.doesNotMatch(html, />-0</);
  });
});

describe('linked subagent tool rows', () => {
  const renderTool = (
    item: ToolActivityItem,
    onOpenLinkedSession?: (sessionId: string) => void,
  ) => renderToStaticMarkup(createElement(ToolTrow, { items: [item], onOpenLinkedSession }));

  it('renders a linked agent as one compact clickable list row', () => {
    const html = renderTool(subagent('child-1'), () => undefined);

    assert.match(html, />Local Read</);
    assert.equal(html.match(/<button\b/g)?.length, 1);
    assert.equal(renderTool(subagent(), () => undefined).match(/<button\b/g)?.length ?? 0, 0);
    assert.equal(renderTool(subagent('child-1')).match(/<button\b/g)?.length ?? 0, 0);
  });

  it('preserves mixed tool and linked-agent order', () => {
    const before = runningTool('tool-before', 'Read');
    before.intent = 'before linked session';
    const linked = subagent('child-1');
    const after = runningTool('tool-after', 'Grep');
    after.intent = 'after linked session';

    const html = renderToStaticMarkup(createElement(ToolTrow, {
      items: [before, linked, after],
      onOpenLinkedSession: () => undefined,
    }));
    const beforeIndex = html.indexOf('before linked session');
    const linkedIndex = html.indexOf('Inspect the runtime');
    const afterIndex = html.indexOf('after linked session');

    assert.ok(beforeIndex >= 0);
    assert.ok(linkedIndex > beforeIndex);
    assert.ok(afterIndex > linkedIndex);
  });

  it('uses the child result status instead of the settled transport status', () => {
    const item = subagent('child-1');
    item.status = 'completed';
    if (item.result?.kind !== 'subagent') throw new Error('expected subagent fixture');
    item.result = {
      ...item.result,
      status: 'failed',
      summary: 'The child could not start',
      failureClass: 'policy_denied',
    };

    const html = renderTool(item, () => undefined);
    assert.match(html, /Error: policy_denied/);
    assert.match(html, />失败 · 只读<\/span>/);
  });

  it('shows the read-only boundary without projecting artifact counts', () => {
    const item = subagent('child-1');
    if (item.result?.kind !== 'subagent') throw new Error('expected subagent fixture');
    const result = { ...item.result, status: 'cancelled' as const, artifactIds: [] };
    item.result = result;
    const withoutArtifacts = renderTool(item, () => undefined);

    item.result = { ...result, artifactIds: ['artifact-1', 'artifact-2'] };
    const withArtifacts = renderTool(item, () => undefined);

    assert.equal(withArtifacts, withoutArtifacts);
    assert.match(withArtifacts, />已取消 · 只读<\/span>/);
  });

  it('links only swarm children that have a session', () => {
    const html = renderTool({
      toolUseId: 'swarm-1',
      toolName: 'agent_swarm',
      status: 'completed',
      args: {},
      result: {
        kind: 'agent_swarm',
        status: 'completed',
        items: [
          {
            itemId: 'reader',
            index: 0,
            profile: 'local_read',
            started: true,
            childSessionId: 'child-reader',
            agentName: 'Reader',
            status: 'completed',
            summary: 'Inspected the runtime',
            artifactIds: [],
          },
          {
            itemId: 'worker',
            index: 1,
            profile: 'implementation',
            started: false,
            agentName: 'Worker',
            status: 'failed',
            summary: 'No child session was created',
            artifactIds: [],
            failureClass: 'startup_failed',
          },
        ],
        startedAt: 0,
        completedAt: 10,
        durationMs: 10,
      },
    }, () => undefined);

    assert.match(html, />Reader</);
    assert.match(html, />Worker</);
    assert.equal(html.match(/<button\b/g)?.length, 1);
    assert.match(html, /startup_failed/);
    assert.match(html, />失败</);
    assert.match(html, />已完成 · 只读<\/span>/);
    assert.doesNotMatch(html, />local_read<\/span>/);
  });

  it('keeps an empty swarm visible as its parent tool row', () => {
    const html = renderTool({
      toolUseId: 'swarm-empty',
      toolName: 'agent_swarm',
      status: 'errored',
      args: {},
      result: {
        kind: 'agent_swarm',
        status: 'failed',
        items: [],
        startedAt: 0,
        completedAt: 10,
        durationMs: 10,
      },
    });

    assert.match(html, />agent_swarm</);
    assert.match(html, /Error: agent_swarm/);
  });
});
