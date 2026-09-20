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
  cancel: string;
  check: string;
  updateError: string;
}

const catalog = {
  en: {
    saved: 'Waiting to send',
    sending: 'Sending…',
    accepted: 'Delivered',
    unknown: 'Delivery unconfirmed. Do not send again.',
    failed: 'Could not send · message kept',
    remove: 'Delete unsent message',
    cancel: 'Cancel sending',
    check: 'Check delivery',
    updateError: 'Unable to update the saved message',
  },
  'zh-CN': {
    saved: '等待发送',
    sending: '正在发送…',
    accepted: '已送达',
    unknown: '暂时无法确认是否送达，请勿重复发送',
    failed: '未能发送 · 消息已保留',
    remove: '删除未发送的消息',
    cancel: '取消发送',
    check: '检查是否送达',
    updateError: '无法更新已保存的消息',
  },
  'zh-TW': {
    saved: '等待傳送',
    sending: '正在傳送…',
    accepted: '已送達',
    unknown: '暫時無法確認是否送達，請勿重複傳送',
    failed: '無法傳送 · 訊息已保留',
    remove: '刪除未傳送的訊息',
    cancel: '取消傳送',
    check: '檢查是否送達',
    updateError: '無法更新已儲存的訊息',
  },
} satisfies UiCatalog<SessionLocalCopy>;

export function getSessionLocalCopy(locale: UiLocale): SessionLocalCopy {
  return catalog[locale];
}
