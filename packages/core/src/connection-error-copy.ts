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

/**
 * Human-readable copy for a not-ready chat connection: maps each
 * `NO_REAL_CONNECTION:<reason>` code to one fix sentence so a first-run / CLI
 * surface does not hand-roll its own table.
 *
 * Pure & sync. `describeChatConfigurationReason` turns a reason into a Chinese
 * sentence naming what is missing and where to fix it (设置 · 模型);
 * `parseNoRealConnectionError` reports whether an error is a NO_REAL_CONNECTION
 * failure and recovers its reason, tolerating both the bare CLI form and the
 * `NO_REAL_CONNECTION:<reason>: <message>` form that IPC wrapping produces.
 *
 * This module is the canonical parser and copy table for both CLI and desktop;
 * surfaces adapt their local event shape here instead of duplicating the rules.
 */

import type { ChatConfigurationReason } from './connection-readiness.js';

export const NO_REAL_CONNECTION_CODE = 'NO_REAL_CONNECTION';

const GENERIC_FIX_COPY = '模型连接暂时无法用于发送，请到 设置 · 模型 检查后重试。';

/**
 * The one hand-maintained table: reason → fix copy. Typed as
 * `Record<ChatConfigurationReason, string>`, so adding a reason to the union
 * fails the build until its copy is added here — completeness and copy live in
 * one place. `CHAT_CONFIGURATION_REASONS` and the parser's known-token set are
 * derived from its keys, so neither can drift from it.
 */
const REASON_FIX_COPY: Record<ChatConfigurationReason, string> = {
  missing_default_connection: '等待配置默认模型。请到 设置 · 模型 添加一个可用模型连接后再发送。',
  connection_missing: '该任务依赖的模型连接已删除，请到 设置 · 模型 重新选择或重建连接。',
  connection_disabled: '当前模型连接已禁用。请到 设置 · 模型 启用或选择其他默认模型。',
  missing_api_key: '当前模型连接还没有可用凭据。请到 设置 · 模型 补齐 API key 或重新登录后再发送。',
  missing_model: '当前模型连接还没有可用模型。请到 设置 · 模型 选择默认模型后再发送。',
  empty_model_list: '当前模型连接没有启用模型。请到 设置 · 模型 添加或启用模型后再发送。',
  model_not_enabled: '当前任务选择的模型未启用。请到 设置 · 模型 重新选择可用模型后再发送。',
  model_not_chat_capable:
    '当前任务选择的模型不能用于聊天。请到 设置 · 模型 重新选择支持聊天的模型后再发送。',
  fake_backend: '当前任务来自旧的本地模拟连接。请到 设置 · 模型 添加真实模型后新建任务。',
  provider_retired:
    '当前模型连接的登录方式已从 Maka 移除，无法用于发送。请到 设置 · 模型 改用其他连接后再发送。',
};

/**
 * Every reason, derived from the copy table so test coverage and the parser's
 * known-token set track the union automatically. Module-scoped (the package
 * index does not re-export it) — only the parser and the tests read it.
 */
export const CHAT_CONFIGURATION_REASONS = Object.keys(REASON_FIX_COPY) as ChatConfigurationReason[];

const KNOWN_CHAT_CONFIGURATION_REASONS: ReadonlySet<string> = new Set(CHAT_CONFIGURATION_REASONS);

/**
 * Fix instructions for a not-ready connection. `undefined` (a missing or
 * unrecognized reason) returns the generic fallback; every known reason has its
 * own line, guaranteed present by the `Record` type above.
 */
export function describeChatConfigurationReason(reason: string | undefined): string {
  return reason !== undefined && KNOWN_CHAT_CONFIGURATION_REASONS.has(reason)
    ? REASON_FIX_COPY[reason as ChatConfigurationReason]
    : GENERIC_FIX_COPY;
}

// `\bNO_REAL_CONNECTION\b` pins the whole code: the trailing boundary stops it
// matching a longer word like `NO_REAL_CONNECTIONS` (the reason group is
// optional, so without the boundary that prefix alone would falsely match and
// swallow an unrelated error). Then capture the reason token whole, up to the
// next delimiter (`:` in the wrapped `...:<reason>: <msg>` form, whitespace, or
// end), so a token that only prefixes a known reason (`missing_api_key2`) is
// not mistaken for it.
const NO_REAL_CONNECTION_RE = /\bNO_REAL_CONNECTION\b(?::([^\s:]+))?/;

export interface ParsedNoRealConnectionError {
  /** True when the error is a `NO_REAL_CONNECTION` failure. */
  matched: boolean;
  /** The known reason, or `undefined` for a missing/unrecognized token. */
  reason?: ChatConfigurationReason;
}

/**
 * Classify a thrown error: whether it is a NO_REAL_CONNECTION failure and, if
 * so, its reason. A matched error with a missing or unrecognized token yields
 * `{ matched: true, reason: undefined }`, so a caller still renders generic fix
 * copy rather than mistaking it for an unrelated failure and re-throwing.
 */
export function parseNoRealConnectionError(error: unknown): ParsedNoRealConnectionError {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(NO_REAL_CONNECTION_RE);
  if (!match) return { matched: false };
  const token = match[1];
  return {
    matched: true,
    reason:
      token && KNOWN_CHAT_CONFIGURATION_REASONS.has(token)
        ? (token as ChatConfigurationReason)
        : undefined,
  };
}
