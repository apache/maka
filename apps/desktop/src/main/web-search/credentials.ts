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

import type { AppSettings } from '@maka/core/settings';

import type { WebSearchCredentialSource } from '@maka/core/web-search';

const TAVILY_ENV_KEYS = ['TAVILY_API_KEY', 'MAKA_TAVILY_API_KEY'] as const;

export function getTavilyEnvApiKey(env: NodeJS.ProcessEnv = process.env): string {
  for (const key of TAVILY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return '';
}

export function getTavilyCredentialSource(
  settings: Pick<AppSettings, 'webSearch'>,
  env: NodeJS.ProcessEnv = process.env,
): WebSearchCredentialSource {
  if (getTavilyEnvApiKey(env).length > 0) return 'env';
  return settings.webSearch.providers.tavily.apiKey.length > 0 ? 'saved' : 'none';
}

export function resolveTavilyApiKey(input: {
  settings: Pick<AppSettings, 'webSearch'>;
  draftKey?: unknown;
  env?: NodeJS.ProcessEnv;
}): string {
  const draft = typeof input.draftKey === 'string' ? input.draftKey.trim() : '';
  if (draft.length > 0) return draft;
  const envKey = getTavilyEnvApiKey(input.env);
  if (envKey.length > 0) return envKey;
  return input.settings.webSearch.providers.tavily.apiKey;
}
