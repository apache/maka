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

/** Shared by request previews, connection probes and SDK base URL resolution. */
export function openAiChatBaseUrl(baseUrl: string): string {
  return openAiBaseUrl(baseUrl);
}

export function openAiChatUrl(baseUrl: string): string {
  return openAiRequestUrl(baseUrl, '/chat/completions');
}

export function openAiResponsesBaseUrl(baseUrl: string): string {
  return openAiBaseUrl(baseUrl);
}

export function openResponsesUrl(baseUrl: string): string {
  return openAiRequestUrl(baseUrl, '/responses');
}

function openAiBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/, '');
  // Accept both a base and a full endpoint, including previously duplicated
  // suffixes. Models on one connection may use either OpenAI protocol.
  // Preserve the gateway's prefix; never assume or insert /v1.
  const endpoint = /\/(?:chat\/completions|responses)$/i;
  while (endpoint.test(path)) {
    path = path.replace(endpoint, '').replace(/\/+$/, '');
  }
  url.pathname = path;
  return url.toString();
}

function openAiRequestUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(openAiBaseUrl(baseUrl));
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${endpoint}`;
  return url.toString();
}
