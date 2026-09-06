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

import type { SubscriptionActionResult } from '@maka/core/oauth-subscription';
import {
  createGitHubCopilotAccountTokens,
  isSupportedGitHubCopilotAccountToken,
  serializeOAuthSubscriptionTokens,
} from '@maka/runtime/subscription-credentials';

const execFileAsync = promisify(execFile);

export interface ImportedGitHubCopilotCredential {
  readonly result: SubscriptionActionResult;
  /** Present only on success; the selected Host validates and commits it. */
  readonly secret?: string;
}

export interface ImportGitHubCopilotLocalCredentialDeps {
  readonly resolveGitHubToken?: () => Promise<string>;
}

/**
 * Discovers a GitHub credential already held by this machine (`gh auth token`
 * or a compatible environment variable) and performs only local shape checks.
 * Provider entitlement, network transport, ordering, and persistence all belong
 * to the selected Host's adoption operation.
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
    return {
      result: { ok: true },
      secret: serializeOAuthSubscriptionTokens(createGitHubCopilotAccountTokens(githubToken)),
    };
  } catch {
    return {
      result: {
        ok: false,
        reason: 'token_exchange_failed',
        message: '未找到可导入的 GitHub 凭据；请先使用 gh 登录或配置兼容凭据。',
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
