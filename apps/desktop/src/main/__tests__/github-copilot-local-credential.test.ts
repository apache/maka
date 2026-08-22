import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { importGitHubCopilotLocalCredential } from '../oauth/github-copilot-local-credential.js';

describe('importGitHubCopilotLocalCredential', () => {
  test('prefers an explicit Copilot Requests credential over the generic GitHub CLI login', async () => {
    const previous = process.env.COPILOT_GITHUB_TOKEN;
    process.env.COPILOT_GITHUB_TOKEN = 'github_pat_copilot_requests';
    let authorization = '';
    try {
      const imported = await importGitHubCopilotLocalCredential({
        fetchFn: async (url, init) => {
          assert.equal(String(url), 'https://api.githubcopilot.com/models');
          authorization = new Headers(init?.headers).get('authorization') ?? '';
          return copilotModelsResponse();
        },
      });

      assert.equal(imported.result.ok, true);
      if (imported.result.ok) {
        assert.deepEqual(
          imported.result.models.map(({ id }) => id),
          ['gpt-5.4'],
        );
      }
      assert.equal(authorization, 'Bearer github_pat_copilot_requests');
    } finally {
      if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
      else process.env.COPILOT_GITHUB_TOKEN = previous;
    }
  });

  test('returns the credential to the caller instead of storing it anywhere local', async () => {
    let requestAuthorization = '';
    const imported = await importGitHubCopilotLocalCredential({
      resolveGitHubToken: async () => 'gho_existing_login\n',
      fetchFn: async (url, init) => {
        assert.equal(String(url), 'https://api.githubcopilot.com/models');
        requestAuthorization = new Headers(init?.headers).get('authorization') ?? '';
        return copilotModelsResponse();
      },
    });

    assert.equal(imported.result.ok, true);
    if (imported.result.ok) {
      assert.deepEqual(
        imported.result.models.map(({ id }) => id),
        ['gpt-5.4'],
      );
    }
    assert.equal(requestAuthorization, 'Bearer gho_existing_login');
    // The Host vault is the only place this credential is written; the shape is
    // the one `setRuntimeHostAccountCredential` commits verbatim.
    assert.deepEqual(JSON.parse(imported.secret ?? ''), {
      access_token: 'gho_existing_login',
      refresh_token: 'gho_existing_login',
      expires_at: Number.MAX_SAFE_INTEGER,
      token_type: 'Bearer',
      base_url: 'https://api.githubcopilot.com',
    });
  });

  test('rejects classic PATs before any Copilot request', async () => {
    let requested = false;
    const imported = await importGitHubCopilotLocalCredential({
      resolveGitHubToken: async () => 'ghp_classic_pat',
      fetchFn: async () => {
        requested = true;
        return Response.json({});
      },
    });

    assert.equal(imported.result.ok, false);
    if (!imported.result.ok) {
      assert.equal(imported.result.reason, 'token_exchange_failed');
      assert.match(imported.result.message, /不支持 classic PAT/);
      assert.equal(imported.result.message.includes('ghp_classic_pat'), false);
    }
    assert.equal(imported.secret, undefined);
    assert.equal(requested, false);
  });

  test('explains subscription or Copilot Requests policy rejection without exposing provider details', async () => {
    const imported = await importGitHubCopilotLocalCredential({
      resolveGitHubToken: async () => 'gho_without_copilot_permission',
      fetchFn: async () => new Response(null, { status: 403 }),
    });

    assert.equal(imported.result.ok, false);
    if (!imported.result.ok) {
      assert.match(imported.result.message, /Copilot Requests/);
      assert.doesNotMatch(imported.result.message, /403|gho_without/);
    }
    assert.equal(imported.secret, undefined);
  });

  test('refuses an account that reaches no Copilot model', async () => {
    const imported = await importGitHubCopilotLocalCredential({
      resolveGitHubToken: async () => 'gho_no_entitlement',
      fetchFn: async () => Response.json({ data: [] }),
    });

    assert.equal(imported.result.ok, false);
    assert.equal(imported.secret, undefined);
  });
});

function copilotModelsResponse(): Response {
  return Response.json({
    data: [
      {
        id: 'gpt-5.4',
        model_picker_enabled: true,
        supported_endpoints: ['/responses'],
        policy: { state: 'enabled' },
        capabilities: {
          limits: { max_prompt_tokens: 128_000, max_output_tokens: 16_000 },
          supports: { tool_calls: true },
        },
      },
    ],
  });
}
