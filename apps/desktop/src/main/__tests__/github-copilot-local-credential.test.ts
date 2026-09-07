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
import { describe, test } from 'node:test';

import { importGitHubCopilotLocalCredential } from '../oauth/github-copilot-local-credential.js';

describe('importGitHubCopilotLocalCredential', () => {
  test('prefers an explicit Copilot Requests credential over the generic GitHub CLI login', async () => {
    const previous = process.env.COPILOT_GITHUB_TOKEN;
    process.env.COPILOT_GITHUB_TOKEN = 'github_pat_copilot_requests';
    try {
      const imported = await importGitHubCopilotLocalCredential();

      assert.deepEqual(JSON.parse(imported.secret ?? ''), {
        access_token: 'github_pat_copilot_requests',
        refresh_token: 'github_pat_copilot_requests',
        expires_at: Number.MAX_SAFE_INTEGER,
        token_type: 'Bearer',
        base_url: 'https://api.githubcopilot.com',
      });
      assert.deepEqual(imported.result, { ok: true });
    } finally {
      if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
      else process.env.COPILOT_GITHUB_TOKEN = previous;
    }
  });

  test('returns credential material without asking GitHub about entitlement', async () => {
    let resolutions = 0;
    const imported = await importGitHubCopilotLocalCredential({
      resolveGitHubToken: async () => {
        resolutions += 1;
        return 'gho_existing_login\n';
      },
    });

    assert.equal(resolutions, 1);
    assert.deepEqual(imported.result, { ok: true });
    assert.deepEqual(JSON.parse(imported.secret ?? ''), {
      access_token: 'gho_existing_login',
      refresh_token: 'gho_existing_login',
      expires_at: Number.MAX_SAFE_INTEGER,
      token_type: 'Bearer',
      base_url: 'https://api.githubcopilot.com',
    });
  });

  test('rejects classic PATs locally', async () => {
    const imported = await importGitHubCopilotLocalCredential({
      resolveGitHubToken: async () => 'ghp_classic_pat',
    });

    assert.equal(imported.result.ok, false);
    if (!imported.result.ok) {
      assert.equal(imported.result.reason, 'token_exchange_failed');
      assert.match(imported.result.message, /不支持 classic PAT/);
      assert.equal(imported.result.message.includes('ghp_classic_pat'), false);
    }
    assert.equal(imported.secret, undefined);
  });

  test('rejects an unsupported local credential shape', async () => {
    const imported = await importGitHubCopilotLocalCredential({
      resolveGitHubToken: async () => 'unsupported-token',
    });

    assert.equal(imported.result.ok, false);
    if (!imported.result.ok) assert.match(imported.result.message, /凭据类型不受支持/);
    assert.equal(imported.secret, undefined);
  });

  test('reports when no local GitHub credential can be discovered', async () => {
    const imported = await importGitHubCopilotLocalCredential({
      resolveGitHubToken: async () => {
        throw new Error('gh is not installed');
      },
    });

    assert.equal(imported.result.ok, false);
    if (!imported.result.ok) assert.match(imported.result.message, /未找到可导入/);
    assert.equal(imported.secret, undefined);
  });
});
