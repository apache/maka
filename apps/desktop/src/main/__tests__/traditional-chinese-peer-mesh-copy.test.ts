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
import { test } from 'node:test';
import { getRuntimeHostPeerMeshCopy } from '../../renderer/features/runtime-host-management/index.js';
import { getDesktopConversationCopy } from '../../renderer/locales/conversation-copy.js';
import { getProviderSettingsCopy } from '../../renderer/features/connection-settings/index.js';
import { settingsTestResultMessage } from '../../renderer/locales/settings-test-result-copy.js';

test('Traditional Chinese Peer Mesh copy does not use the Simplified Chinese branch', () => {
  const copy = getRuntimeHostPeerMeshCopy('zh-TW');

  assert.equal(copy.experimental, '實驗性');
  assert.equal(copy.invalidResult, 'Peer Mesh 回傳了無效結果');
  assert.equal(copy.copyPeerId('peer-1'), '複製完整 Peer ID：peer-1');
  assert.equal(copy.peerIdCopyFailed, '無法複製 Peer ID');
  assert.equal(copy.peerPathDirect, '直接連線');
  assert.equal(copy.peerPathTransit, '成員轉送');
  assert.equal(copy.peerPathOther, '其他');
  assert.equal(copy.joinHint, '貼上另一個 Peer 產生的一次性邀請碼。');
});

test('Traditional Chinese connection copy uses 回傳, 回應, and 發送', () => {
  const conversation = getDesktopConversationCopy('zh-TW');
  assert.equal(conversation.quoteCompanion.errors.respondFailed, '回應失敗，請稍後重試。');
  assert.match(conversation.health.reauth.tooltip, /回傳鑑權失敗/);
  assert.match(conversation.health.reauth.tooltip, /攔截發送/);
  assert.match(conversation.health.testError.tooltip, /攔截發送/);
  assert.match(conversation.turnError.provider, /模型服務回傳錯誤/);

  const provider = getProviderSettingsCopy('zh-TW');
  assert.equal(provider.shared.lastTest['模型服务返回错误'], '模型服務回傳錯誤');
  assert.equal(provider.shared.lastTest['provider returned an error'], '模型服務回傳錯誤');

  assert.equal(
    settingsTestResultMessage(
      { ok: false, code: 'proxy_http_error', message: '', details: { status: 502 } },
      'zh-TW',
    ),
    '代理測試回傳 HTTP 502，請檢查代理服務或測試地址。',
  );
});
