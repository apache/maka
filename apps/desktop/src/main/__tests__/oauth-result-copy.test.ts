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

import assert from "node:assert/strict";
import test from "node:test";
// Lives under main/__tests__ on purpose: desktop main tests run from dist via
// `node --test "dist/main/**/*.test.js"`, and settings-provider-copy is a pure
// copy module (no react), so it is safe to exercise from node. Same precedent
// as permission-center-copy.test.ts.
import {
  connectionTestFailureMessage,
  subscriptionResultMessage,
} from "../../renderer/features/connection-settings/index.js";

test("renders a coded Copilot import failure per locale, ignoring its machine message", () => {
  const result = { code: "copilot_subscription_unavailable", message: "copilot_subscription_unavailable" };
  assert.equal(subscriptionResultMessage(result, "fallback", "zh-CN"), "当前 GitHub 账号没有可用的 Copilot 订阅权限。");
  assert.equal(subscriptionResultMessage(result, "fallback", "en"), "This GitHub account has no usable Copilot subscription.");
});

test("renders the typed experimental_disabled reason per locale", () => {
  const result = { reason: "experimental_disabled", message: "enrollment is disabled for this provider" };
  assert.equal(subscriptionResultMessage(result, "fallback", "zh-CN"), "本机未启用该账号登录方式；可改用导入兼容凭据，或由管理员启用后重试。");
  assert.equal(subscriptionResultMessage(result, "fallback", "en"), "This sign-in is not enabled on this install. Import a compatible credential instead, or ask an operator to enable it.");
});

test("renders the typed login_in_progress and presentation_failed reasons per locale", () => {
  const conflict = { reason: "login_in_progress", message: "Another OAuth login is already in progress" };
  assert.equal(subscriptionResultMessage(conflict, "fallback", "zh-CN"), "上一轮登录仍在进行，等它结束后再点登录。");
  assert.equal(subscriptionResultMessage(conflict, "fallback", "en"), "A previous login is still running. Start again after it settles.");
  const presentation = { reason: "presentation_failed", message: "Desktop has no matching OAuth presentation request" };
  assert.equal(subscriptionResultMessage(presentation, "fallback", "zh-CN"), "无法打开系统浏览器完成登录，请检查是否拦截了弹窗后重试。");
  assert.equal(subscriptionResultMessage(presentation, "fallback", "en"), "Could not open the system browser for login. Check popup blockers and try again.");
});

test("presentation prose no longer hijacks the presenter after the regex removal", () => {
  const legacy = { message: "Runtime Host did not present OAuth authorization" };
  assert.notEqual(subscriptionResultMessage(legacy, "fallback", "en"), "Could not open the system browser for login. Check popup blockers and try again.");
});

test("falls back to catalog copy for an unknown code instead of the raw message", () => {
  const result = { code: "not_a_known_code", message: "内部错误" };
  assert.equal(subscriptionResultMessage(result, "fallback", "en"), "fallback");
  assert.equal(subscriptionResultMessage(result, "fallback", "zh-CN"), "fallback");
});

test("renders provider rate limits consistently from the stable status code", () => {
  const result = { ok: false, statusCode: 429, errorClass: "provider_unavailable" } as const;
  const troubleshooting = { auth: "auth", recheck: "recheck" };
  assert.equal(
    connectionTestFailureMessage(result, troubleshooting, "zh-CN"),
    "当前账号或模型服务触发速率限制，请稍后重试。",
  );
  assert.equal(
    connectionTestFailureMessage(result, troubleshooting, "en"),
    "This account or model service is rate-limited. Try again later.",
  );
});

test("rejects raw backend prose for Traditional Chinese subscription errors", () => {
  assert.equal(
    subscriptionResultMessage("GitHub Copilot 登录已过期。", "請重新登入。", "zh-TW"),
    "請重新登入。",
  );
  assert.equal(
    subscriptionResultMessage("network unreachable", "請重新登入。", "zh-TW"),
    "網路錯誤",
  );
});
