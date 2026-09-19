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

/** Trae CLI wire contract; see docs/trae-provider.md for provenance. */
export const TRAE = {
  baseUrl: 'https://copilot-cn.bytedance.net',
  appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  function: 'traecli_next',
  catalogPath: '/api/ide/v1/get_detail_param',
  chatPath: '/api/ide/v2/llm_raw_chat',
  authBaseUrl: 'https://cloud.bytedance.net',
  authPath: '/api/v1/ai_auth/ai/auth/service_account_app/',
} as const;

export function traeHeaders(accessToken: string): Record<string, string> {
  return {
    'x-jwt-token': accessToken,
    'x-app-id': TRAE.appId,
    'x-ide-function': TRAE.function,
    'x-ide-version-code': new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date())
      .replaceAll('-', ''),
    'content-type': 'application/json',
    'user-agent': 'Maka/0.2.0',
  };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
