import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeToolResultPreviewContent,
  materializeToolResultPreviewForActivity,
} from '../tool-result-preview.js';

describe('tool_result_preview open-facts', () => {
  it('decodes and materializes a subagent preview with empty bulk', () => {
    const preview = decodeToolResultPreviewContent({
      kind: 'subagent',
      childSessionId: 'child-1',
      agentId: 'local_read',
      agentName: 'Local Read',
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
      permissionMode: 'explore',
    });
    assert.equal(preview.kind, 'subagent');
    assert.deepEqual(materializeToolResultPreviewForActivity(preview), {
      kind: 'subagent',
      childSessionId: 'child-1',
      agentId: 'local_read',
      agentName: 'Local Read',
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
      permissionMode: 'explore',
      summary: '',
      artifactIds: [],
    });
  });

  it('rejects bulk fields and unknown kinds', () => {
    assert.throws(() =>
      decodeToolResultPreviewContent({
        kind: 'subagent',
        agentName: 'X',
        turnId: 't',
        status: 'running',
        permissionMode: 'ask',
        summary: 'nope',
      }),
    );
    assert.throws(() =>
      decodeToolResultPreviewContent({ kind: 'agent_swarm', status: 'running', items: [] }),
    );
  });
});
