import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateMcpEditorDraft } from '../../renderer/mcp-editor-validation.js';

describe('MCP editor validation', () => {
  it('requires a server id and the selected transport endpoint', () => {
    assert.deepEqual(
      validateMcpEditorDraft({
        id: ' ',
        kind: 'stdio',
        command: '',
        url: '',
      }),
      { id: 'required', command: 'required' },
    );
    assert.deepEqual(
      validateMcpEditorDraft({
        id: '',
        kind: 'remote',
        command: '',
        url: ' ',
      }),
      { id: 'required', url: 'required' },
    );
  });

  it('accepts only HTTP(S) URLs for remote servers', () => {
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'remote',
        kind: 'remote',
        command: '',
        url: 'not a url',
      }),
      { url: 'invalid-url' },
    );
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'remote',
        kind: 'remote',
        command: '',
        url: 'file:///tmp/server',
      }),
      { url: 'invalid-url' },
    );
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'remote',
        kind: 'remote',
        command: '',
        url: 'https://example.com/mcp',
      }),
      {},
    );
  });
});
