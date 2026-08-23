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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ModelInfo } from '@maka/core/llm-connections';
import type { SubscriptionActionResult } from '@maka/core/oauth-subscription';
import {
  createGitHubCopilotAccountTokens,
  isSupportedGitHubCopilotAccountToken,
  serializeOAuthSubscriptionTokens,
} from '@maka/runtime/subscription-credentials';
import { fetchGitHubCopilotModels } from '@maka/runtime/model-fetcher';

const execFileAsync = promisify(execFile);

export interface ImportedGitHubCopilotCredential {
  readonly result:
    | { readonly ok: true; readonly models: ModelInfo[] }
    | Exclude<SubscriptionActionResult, { ok: true }>;
  /** Present only on success; the caller commits it to the Host vault. */
  readonly secret?: string;
}

export interface ImportGitHubCopilotLocalCredentialDeps {
  readonly resolveGitHubToken?: () => Promise<string>;
  readonly fetchFn?: typeof fetch;
}

/**
 * Reads a GitHub credential this machine already holds (`gh auth token`, or one
 * of the `*_TOKEN` environment variables) and validates that it reaches a
 * Copilot model.
 *
 * This is the one Copilot responsibility that genuinely depends on the local
 * machine, so it is the only one Desktop keeps: interactive enrollment, account
 * state, refresh, and sign-out all belong to the Host's OAuth coordinator. It
 * holds no state between calls — the credential is returned to the caller and
 * never written to disk here.
 */
export async function importGitHubCopilotLocalCredential(
  deps: ImportGitHubCopilotLocalCredentialDeps = {},
): Promise<ImportedGitHubCopilotCredential> {
  const resolveToken = deps.resolveGitHubToken ?? resolveGitHubAccountToken;
  try {
    const githubToken = (await resolveToken()).trim();
    if (githubToken.startsWith('ghp_')) {
      return {
        result: {
          ok: false,
          reason: 'token_exchange_failed',
          message:
            'GitHub Copilot 不支持 classic PAT；请使用兼容 OAuth 登录或具有 Copilot Requests 权限的 fine-grained PAT。',
        },
      };
    }
    if (!isSupportedGitHubCopilotAccountToken(githubToken)) {
      return {
        result: {
          ok: false,
          reason: 'token_exchange_failed',
          message: '当前 GitHub 凭据类型不受支持；请使用兼容 OAuth 登录或 fine-grained PAT。',
        },
      };
    }
    const tokens = createGitHubCopilotAccountTokens(githubToken);
    const models = await fetchGitHubCopilotModels(
      tokens.base_url!,
      tokens.access_token,
      deps.fetchFn,
    );
    if (models.length === 0) throw new Error('GitHub Copilot account returned no usable models.');
    return { result: { ok: true, models }, secret: serializeOAuthSubscriptionTokens(tokens) };
  } catch {
    return {
      result: {
        ok: false,
        reason: 'token_exchange_failed',
        message:
          '无法连接 GitHub Copilot。请确认账号具有订阅访问权限，且凭据具有 Copilot Requests 权限；普通 gh auth login 可能不包含该权限。',
      },
    };
  }
}

async function resolveGitHubAccountToken(): Promise<string> {
  for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const) {
    const token = process.env[name]?.trim();
    if (token) return token;
  }
  const result = await execFileAsync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  return result.stdout;
}
