import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeToolResultPreviewContent } from '../tool-result-preview.js';

describe('tool_result_preview open-facts', () => {
  it('rejects missing childSessionId, bulk fields, and non-running status', () => {
    assert.throws(() =>
      decodeToolResultPreviewContent({
        kind: 'subagent',
        agentName: 'X',
        turnId: 't',
        status: 'running',
        permissionMode: 'ask',
      }),
    );
    assert.throws(() =>
      decodeToolResultPreviewContent({
        kind: 'subagent',
        childSessionId: 'child-1',
        agentName: 'X',
        turnId: 't',
        status: 'running',
        permissionMode: 'ask',
        summary: 'nope',
      }),
    );
    assert.throws(() =>
      decodeToolResultPreviewContent({
        kind: 'subagent',
        childSessionId: 'child-1',
        agentName: 'X',
        turnId: 't',
        status: 'waiting_for_user',
        permissionMode: 'ask',
      }),
    );
    assert.throws(() =>
      decodeToolResultPreviewContent({ kind: 'agent_swarm', status: 'running', items: [] }),
    );
  });
});
