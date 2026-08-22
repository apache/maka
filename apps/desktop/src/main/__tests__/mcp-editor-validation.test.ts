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
  it('reports substantive URL and command errors for live first-edit display', () => {
    // The page shows every non-presence error on the FIRST edit; these are
    // the codes that must therefore exist immediately, not only on save.
    assert.deepEqual(
      validateMcpEditorDraft({ id: 'a', kind: 'remote', commandLine: '', url: 'http://lan.example/mcp', headers: '' }),
      { url: 'insecure-url' },
    );
    assert.deepEqual(
      validateMcpEditorDraft({ id: 'a', kind: 'remote', commandLine: '', url: 'not a url', headers: '' }),
      { url: 'invalid-url' },
    );
    assert.deepEqual(
      validateMcpEditorDraft({ id: 'a', kind: 'stdio', commandLine: 'npx "unterminated', url: '', headers: '' }),
      { commandLine: 'unbalanced-quote' },
    );
  });


  it('rejects a remote URL with embedded credentials, mirroring the store', () => {
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'api',
        kind: 'remote',
        commandLine: '',
        url: 'https://user:pass@example.com/mcp',
        headers: '',
      }),
      { url: 'url-credentials' },
    );
  });


  it('requires a server id and the selected transport endpoint', () => {
    assert.deepEqual(
      validateMcpEditorDraft({
        id: ' ',
        kind: 'stdio',
        commandLine: '',
        url: '',
        headers: '',
      }),
      { id: 'required', commandLine: 'required' },
    );
    assert.deepEqual(
      validateMcpEditorDraft({
        id: '',
        kind: 'remote',
        commandLine: '',
        url: ' ',
        headers: '',
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
        headers: '',
      }),
      {},
    );
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'filesystem',
        kind: 'stdio',
        commandLine: 'npx "unterminated',
        url: '',
        headers: '',
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
        headers: '',
      }),
      { commandLine: 'required' },
    );
  });

  it('rejects an id that would silently overwrite an existing server', () => {
    const draft = {
      id: ' notion ',
      kind: 'stdio',
      commandLine: 'npx server',
      url: '',
      headers: '',
    } as const;
    assert.deepEqual(
      validateMcpEditorDraft(draft, { existingIds: ['notion', 'filesystem'] }),
      { id: 'duplicate-id' },
    );
    // Edit mode passes no existingIds — writing over your own id is the
    // point of editing.
    assert.deepEqual(validateMcpEditorDraft(draft), {});
    assert.deepEqual(
      validateMcpEditorDraft(draft, { existingIds: ['filesystem'] }),
      {},
    );
  });

  it('accepts only HTTP(S) URLs for remote servers', () => {
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'remote',
        kind: 'remote',
        commandLine: '',
        url: 'not a url',
        headers: '',
      }),
      { url: 'invalid-url' },
    );
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'remote',
        kind: 'remote',
        commandLine: '',
        url: 'file:///tmp/server',
        headers: '',
      }),
      { url: 'invalid-url' },
    );
    assert.deepEqual(
      validateMcpEditorDraft({
        id: 'remote',
        kind: 'remote',
        commandLine: '',
        url: 'https://example.com/mcp',
        headers: '',
      }),
      {},
    );
  });

  it('mirrors the store rule: no Authorization header on an OAuth server', () => {
    // The dialog has no OAuth field — the block rides the draft opaquely —
    // so without this mirror the placeholder invites exactly the header the
    // store rejects, and the save bounces as a raw untranslated toast.
    const base = {
      id: 'notion',
      kind: 'remote' as const,
      commandLine: '',
      url: 'https://mcp.notion.com/mcp',
    };
    assert.deepEqual(
      validateMcpEditorDraft(
        { ...base, headers: 'Authorization=Bearer t\nX-Workspace=w1' },
        { hasOAuth: true },
      ),
      { headers: 'oauth-authorization-conflict' },
    );
    // Case-insensitive, like the store's check.
    assert.deepEqual(
      validateMcpEditorDraft({ ...base, headers: 'authorization=Bearer t' }, { hasOAuth: true }),
      { headers: 'oauth-authorization-conflict' },
    );
    // No oauth block → the header is the user's to configure.
    assert.deepEqual(
      validateMcpEditorDraft({ ...base, headers: 'Authorization=Bearer t' }, {}),
      {},
    );
    // OAuth with other headers is fine.
    assert.deepEqual(
      validateMcpEditorDraft({ ...base, headers: 'X-Workspace=w1' }, { hasOAuth: true }),
      {},
    );
  });

  it('mirrors the store rule: cleartext http only for loopback hosts', () => {
    const draft = (url: string) =>
      validateMcpEditorDraft({ id: 'remote', kind: 'remote', commandLine: '', url, headers: '' });
    assert.deepEqual(draft('http://192.168.1.50:8080/mcp'), { url: 'insecure-url' });
    assert.deepEqual(draft('http://example.com/mcp'), { url: 'insecure-url' });
    // `*.localhost` is no longer a loopback trust root: Node resolves it
    // through the system resolver, so its loopback-ness is not guaranteed.
    assert.deepEqual(draft('http://dev.localhost/mcp'), { url: 'insecure-url' });
    for (const url of [
      'http://127.0.0.1:8080/mcp',
      'http://localhost:3000/mcp',
      'http://[::1]:3000/mcp',
    ]) {
      assert.deepEqual(draft(url), {}, url);
    }
  });
});
