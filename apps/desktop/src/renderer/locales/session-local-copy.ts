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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

interface SessionLocalCopy {
  saved: string;
  sending: string;
  accepted: string;
  unknown: string;
  failed: string;
  remove: string;
  check: string;
  updateError: string;
}

const catalog = {
  en: {
    saved: 'Saved locally · waiting to send',
    sending: 'Delivering to Host',
    accepted: 'Host accepted',
    unknown: 'Host outcome unknown',
    failed: 'Not sent · local copy retained',
    remove: 'Remove local copy',
    check: 'Check status',
    updateError: 'Unable to update the saved message',
  },
  'zh-CN': {
    saved: '已本地保存 · 等待发送',
    sending: '正在投递到 Host',
    accepted: 'Host 已接受',
    unknown: 'Host 接受结果未知',
    failed: '未发送 · 本地副本已保留',
    remove: '移除本地副本',
    check: '核对状态',
    updateError: '无法更新已保存的消息',
  },
  'zh-TW': {
    saved: '已儲存於本機 · 等待傳送',
    sending: '正在投遞至 Host',
    accepted: 'Host 已接受',
    unknown: 'Host 接受結果未知',
    failed: '未傳送 · 本機副本已保留',
    remove: '移除本機副本',
    check: '核對狀態',
    updateError: '無法更新已儲存的訊息',
  },
} satisfies UiCatalog<SessionLocalCopy>;

export function getSessionLocalCopy(locale: UiLocale): SessionLocalCopy {
  return catalog[locale];
}
