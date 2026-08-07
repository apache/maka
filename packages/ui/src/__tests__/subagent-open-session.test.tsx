import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolResultContent } from '@maka/core';
import { LocaleProvider } from '../locale-context.js';
import { AgentSwarmPreview, SubagentPreview } from '../tool-activity/agent-preview.js';

function subagentResult(
  overrides: Partial<Extract<ToolResultContent, { kind: 'subagent' }>> = {},
): Extract<ToolResultContent, { kind: 'subagent' }> {
  return {
    kind: 'subagent',
    agentName: 'explore · layout',
    turnId: 'turn-1',
    status: 'running',
    permissionMode: 'ask',
    summary: '',
    artifactIds: [],
    ...overrides,
  };
}

function swarmResult(
  items: Extract<ToolResultContent, { kind: 'agent_swarm' }>['items'],
): Extract<ToolResultContent, { kind: 'agent_swarm' }> {
  return {
    kind: 'agent_swarm',
    status: 'completed',
    items,
    startedAt: 0,
    completedAt: 1,
    durationMs: 1,
  };
}

describe('SubagentPreview open session', () => {
  it('renders an open control when childSessionId and onOpenSession are present', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <SubagentPreview
          result={subagentResult({ childSessionId: 'child-1' })}
          onOpenSession={() => undefined}
        />
      </LocaleProvider>,
    );
    assert.match(html, /data-maka-contract="open-subagent-session"/);
    assert.match(html, /Open session/);
  });

  it('hides the open control when childSessionId is missing', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <SubagentPreview result={subagentResult()} onOpenSession={() => undefined} />
      </LocaleProvider>,
    );
    assert.doesNotMatch(html, /data-maka-contract="open-subagent-session"/);
  });

  it('hides the open control when the host omits onOpenSession', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <SubagentPreview result={subagentResult({ childSessionId: 'child-1' })} />
      </LocaleProvider>,
    );
    assert.doesNotMatch(html, /data-maka-contract="open-subagent-session"/);
  });
});

describe('AgentSwarmPreview open session', () => {
  it('renders an open control for items that carry childSessionId', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <AgentSwarmPreview
          result={swarmResult([
            {
              itemId: 'item-1',
              index: 0,
              profile: 'local_read',
              started: true,
              childSessionId: 'child-swarm-1',
              agentName: 'reader',
              status: 'completed',
              summary: 'done',
              artifactIds: [],
            },
            {
              itemId: 'item-2',
              index: 1,
              profile: 'local_read',
              started: true,
              status: 'completed',
              summary: 'no session',
              artifactIds: [],
            },
          ])}
          onOpenSession={() => undefined}
        />
      </LocaleProvider>,
    );
    assert.equal(
      html.match(/data-maka-contract="open-subagent-session"/g)?.length,
      1,
      'only the item with childSessionId opens',
    );
  });

  it('hides open controls when the host omits onOpenSession', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <AgentSwarmPreview
          result={swarmResult([
            {
              itemId: 'item-1',
              index: 0,
              profile: 'local_read',
              started: true,
              childSessionId: 'child-swarm-1',
              status: 'completed',
              summary: 'done',
              artifactIds: [],
            },
          ])}
        />
      </LocaleProvider>,
    );
    assert.doesNotMatch(html, /data-maka-contract="open-subagent-session"/);
  });
});
