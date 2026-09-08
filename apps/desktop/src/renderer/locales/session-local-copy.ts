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

const en = {
  saved: 'Waiting to send', sending: 'Sending', accepted: 'Delivered · waiting for an update',
  unknown: 'Delivery not confirmed', failed: 'Message not sent', checking: 'Checking delivery',
  offline: 'Waiting for a connection', queued: 'Queued for the next reply',
  steering: 'Waiting to join the current reply', inFlight: 'Added to the current reply',
  processing: 'Processing this message', started: 'Reply started · waiting for an update',
  acceptedSteering: 'Delivered as input to the current reply',
  acceptedFollowup: 'Delivered for a later reply · waiting for an update',
  remove: 'Delete failed message', cancel: 'Cancel sending', check: 'Check delivery',
  edit: 'Edit and resend', busy: 'Updating message', diagnostics: 'Delivery details',
  failedDetail: 'Edit this message to send it again. Deleting it does not stop a running reply.',
  unknownDetail: 'This message may have arrived. Check its delivery before sending it again.',
  retryDetail: 'Delivery will be checked again automatically when connected.',
  savedDetail: 'Saved on this device. It will send when delivery is available.',
  steeringDetail: 'This input can guide the current reply; it does not start a separate reply.',
  queuedDetail: 'This input is waiting for a later reply. Its position follows the current message queue.',
  updateError: 'Unable to update this message. Its saved copy is still available.',
  draftBlocked: 'Finish or clear the current draft, attachments and quotes before editing this message.',
  draftReady: 'Ready to edit. The failed message is kept until you delete it.',
};
type SessionLocalCopy = { [K in keyof typeof en]: string };
const catalog = {
  en,
  'zh-CN': {
    saved: '等待发送', sending: '正在发送', accepted: '已送达 · 等待状态更新',
    unknown: '发送结果待确认', failed: '消息未发送', checking: '正在确认发送结果',
    offline: '等待连接恢复', queued: '已排队，等待下一轮回复',
    steering: '等待加入当前回复', inFlight: '已加入当前回复',
    processing: '正在处理这条消息', started: '回复已开始 · 等待状态更新',
    acceptedSteering: '已作为当前回复的补充消息送达',
    acceptedFollowup: '已作为后续消息送达 · 等待状态更新',
    remove: '删除失败消息', cancel: '取消发送', check: '确认发送结果',
    edit: '编辑后重发', busy: '正在更新消息', diagnostics: '发送详情',
    failedDetail: '可以编辑后重新发送。删除这条消息不会停止正在进行的回复。',
    unknownDetail: '这条消息可能已送达。再次发送前，请先确认发送结果。',
    retryDetail: '连接可用时会自动再次确认发送结果。',
    savedDetail: '已保存在此设备上，将在可以发送时继续发送。',
    steeringDetail: '这条补充消息可用于当前回复，不会单独开启一轮回复。',
    queuedDetail: '这条消息正在等待后续回复，顺序以当前消息队列为准。',
    updateError: '无法更新这条消息，已保存的内容仍然保留。',
    draftBlocked: '请先完成或清空输入框中的草稿、附件和引用，再编辑这条消息。',
    draftReady: '已恢复到输入框，可编辑后发送。失败消息会保留，直到你删除它。',
  },
  'zh-TW': {
    saved: '等待傳送', sending: '正在傳送', accepted: '已送達 · 等待狀態更新',
    unknown: '傳送結果待確認', failed: '訊息未傳送', checking: '正在確認傳送結果',
    offline: '等待連線恢復', queued: '已排入佇列，等待下一輪回覆',
    steering: '等待加入目前回覆', inFlight: '已加入目前回覆',
    processing: '正在處理這則訊息', started: '回覆已開始 · 等待狀態更新',
    acceptedSteering: '已作為目前回覆的補充訊息送達',
    acceptedFollowup: '已作為後續訊息送達 · 等待狀態更新',
    remove: '刪除失敗訊息', cancel: '取消傳送', check: '確認傳送結果',
    edit: '編輯後重送', busy: '正在更新訊息', diagnostics: '傳送詳情',
    failedDetail: '可以編輯後重新傳送。刪除這則訊息不會停止正在進行的回覆。',
    unknownDetail: '這則訊息可能已送達。再次傳送前，請先確認傳送結果。',
    retryDetail: '連線可用時會自動再次確認傳送結果。',
    savedDetail: '已儲存在此裝置上，將在可以傳送時繼續傳送。',
    steeringDetail: '這則補充訊息可用於目前回覆，不會單獨開啟一輪回覆。',
    queuedDetail: '這則訊息正在等待後續回覆，順序以目前訊息佇列為準。',
    updateError: '無法更新這則訊息，已儲存的內容仍然保留。',
    draftBlocked: '請先完成或清空輸入框中的草稿、附件和引用，再編輯這則訊息。',
    draftReady: '已恢復到輸入框，可編輯後傳送。失敗訊息會保留，直到你刪除它。',
  },
} satisfies UiCatalog<SessionLocalCopy>;

export function getSessionLocalCopy(locale: UiLocale): SessionLocalCopy { return catalog[locale]; }
