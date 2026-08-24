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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateMcpEditorDraft } from '../../renderer/mcp-editor-validation.js';

describe('MCP editor validation', () => {
  it('requires a server id and the selected transport endpoint', () => {
    assert.deepEqual(
      validateMcpEditorDraft({
        id: ' ',
        kind: 'stdio',
        commandLine: '',
        url: '',
      }),
      { id: 'required', commandLine: 'required' },
    );
    assert.deepEqual(
      validateMcpEditorDraft({
        id: '',
        kind: 'remote',
        commandLine: '',
        url: ' ',
      }),
      { id: 'required', url: 'required' },
    );
  });

  it('accepts a full command line and rejects unbalanced quotes', () => {
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'filesystem',
        kind: 'stdio',
        commandLine: 'npx -y @modelcontextprotocol/server-filesystem "/my folder"',
        url: '',
      }),
      {},
    );
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'filesystem',
        kind: 'stdio',
        commandLine: 'npx "unterminated',
        url: '',
      }),
      { commandLine: 'unbalanced-quote' },
    );
    // Quotes around nothing still parse; an empty command is missing, not
    // malformed.
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'filesystem',
        kind: 'stdio',
        commandLine: '""',
        url: '',
      }),
      { commandLine: 'required' },
    );
  });

  it('accepts only HTTP(S) URLs for remote servers', () => {
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'remote',
        kind: 'remote',
        commandLine: '',
        url: 'not a url',
      }),
      { url: 'invalid-url' },
    );
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'remote',
        kind: 'remote',
        commandLine: '',
        url: 'file:///tmp/server',
      }),
      { url: 'invalid-url' },
    );
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'remote',
        kind: 'remote',
        commandLine: '',
        url: 'https://example.com/mcp',
      }),
      {},
    );
  });
});
