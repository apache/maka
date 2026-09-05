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
import { settingsTestResultMessage } from "../../renderer/locales/settings-test-result-copy.js";
import { toSettingsTestResult } from "../settings-ipc-helpers.js";

test("missing proxy credentials have actionable bilingual copy", () => {
  const result = {
    ok: false,
    code: "proxy_credential_missing",
    message: "Proxy credential is not configured",
  } as never;

  assert.equal(
    settingsTestResultMessage(result, "zh-CN"),
    "代理认证已开启，请输入代理密码后再测试。",
  );
  assert.equal(
    settingsTestResultMessage(result, "en"),
    "Proxy authentication is enabled. Enter a proxy password before testing.",
  );
});


test("renders a bot-test error code per locale without content sniffing", () => {
  const result = toSettingsTestResult("dingtalk", {
    ok: false,
    errorCode: "dingtalk_credentials_missing",
  });
  assert.equal(result.code, "bot_app_credentials_missing");
  assert.equal(settingsTestResultMessage(result, "zh-CN"), "请填写 App ID 和 App Secret 后再测试。");
  assert.equal(
    settingsTestResultMessage(result, "en"),
    "Enter an App ID and App Secret before testing the connection.",
  );
});
