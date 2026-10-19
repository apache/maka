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

import { defineShippedUiMessageCatalog, resolveUiMessageCatalog } from '@maka/core/ui-locale';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

const en = {
  saved: 'Waiting to send',
  paused: 'Sending paused', resume: 'Continue sending',
  pausedDetail: 'Draft edits are not kept after a restart. The original stays saved and paused. Clear the draft to discard edits; edit the original again to recover it or choose Continue sending.',
  recoverySourceExpired: 'An attachment is no longer available. To restore attachments from the original message, first copy your text edits, clear the draft, attachments and references, then edit the original message again.',
  mixedSourcesExpired: 'An attachment is no longer available. Remove and reselect files added during editing, then retry. If an attachment is still unavailable, first copy your text edits, clear the draft, attachments and references, then edit the original again and re-add the other files.',
  restoreUnavailable: 'Unable to restore the draft. The original is saved and paused. Try editing it again.',
  resumeBlocked: 'Clear the draft, attachments and quotes before continuing to send the original message.',
  removeBlocked: 'Unable to delete this paused message right now. Try again when the composer is available and has no draft, attachments or references.',
  unknown: 'Delivery not confirmed', failed: 'Message not sent', checking: 'Checking delivery',
  offline: 'Waiting for a connection',
  remove: 'Delete failed message', cancel: 'Cancel sending', check: 'Check delivery',
  edit: 'Edit and resend', busy: 'Updating message', diagnostics: 'Delivery details',
  editUnsent: 'Edit', removeUnsent: 'Delete unsent message',
  failedDetail: 'Edit this message to send it again. Deleting it does not stop a running reply.',
  unknownDetail: 'This message may have arrived. Check its delivery before sending it again.',
  retryDetail: 'Delivery will be checked again automatically when connected.',
  savedDetail: 'Saved on this device. It will send when delivery is available.',
  updateError: 'Unable to update this message. Its saved copy is still available.',
  draftBlocked: 'Finish or clear the current draft, attachments and quotes before editing this message.',
  draftReady: 'Ready to edit. The failed message is kept until you delete it.',
};
type SessionLocalCopy = { [K in keyof typeof en]: string };
const catalog = resolveUiMessageCatalog(defineShippedUiMessageCatalog<SessionLocalCopy>()({
  en,
  'zh-CN': {
    saved: '等待发送',
    paused: '已暂停发送', resume: '继续发送',
    pausedDetail: '草稿中的修改不会在重启后保留，原消息仍会保存并暂停发送。清空草稿即可放弃修改；再次编辑原消息可恢复内容，也可选择“继续发送”。',
    recoverySourceExpired: '有附件已失效。如需恢复原消息的附件，请先复制文字改动，清空草稿、附件和引用，再次编辑原消息。',
    mixedSourcesExpired: '有附件已失效。请移除并重新选择编辑时新添加的文件，再重试。如果附件仍不可用，请先复制文字改动，清空草稿、附件和引用，再次编辑原消息，并重新添加其他文件。',
    restoreUnavailable: '无法恢复到输入框，原消息已保存并暂停发送，请再次编辑。',
    resumeBlocked: '请先清空草稿、附件和引用，再继续发送原消息。',
    removeBlocked: '暂时无法删除这条暂停消息。请在输入框可用，且没有草稿、附件或引用时重试。',
    unknown: '发送结果待确认', failed: '消息未发送', checking: '正在确认发送结果',
    offline: '等待连接恢复',
    remove: '删除失败消息', cancel: '取消发送', check: '确认发送结果',
    edit: '编辑后重发', busy: '正在更新消息', diagnostics: '发送详情',
    editUnsent: '编辑', removeUnsent: '删除未发送的消息',
    failedDetail: '可以编辑后重新发送。删除这条消息不会停止正在进行的回复。',
    unknownDetail: '这条消息可能已送达。再次发送前，请先确认发送结果。',
    retryDetail: '连接可用时会自动再次确认发送结果。',
    savedDetail: '已保存在此设备上，将在可以发送时继续发送。',
    updateError: '无法更新这条消息，已保存的内容仍然保留。',
    draftBlocked: '请先完成或清空输入框中的草稿、附件和引用，再编辑这条消息。',
    draftReady: '已恢复到输入框，可编辑后发送。失败消息会保留，直到你删除它。',
  },
  'zh-TW': {
    saved: '等待傳送',
    paused: '已暫停傳送', resume: '繼續傳送',
    pausedDetail: '草稿中的修改不會在重新啟動後保留，原訊息仍會儲存並暫停傳送。清空草稿即可放棄修改；再次編輯原訊息可恢復內容，也可選擇「繼續傳送」。',
    recoverySourceExpired: '有附件已失效。如需恢復原訊息的附件，請先複製文字改動，清空草稿、附件和引用，再次編輯原訊息。',
    mixedSourcesExpired: '有附件已失效。請移除並重新選擇編輯時新增的檔案，再重試。如果附件仍無法使用，請先複製文字改動，清空草稿、附件和引用，再次編輯原訊息，並重新加入其他檔案。',
    restoreUnavailable: '無法恢復到輸入框，原訊息已儲存並暫停傳送，請再次編輯。',
    resumeBlocked: '請先清空草稿、附件和引用，再繼續傳送原訊息。',
    removeBlocked: '暫時無法刪除這則暫停訊息。請在輸入框可用，且沒有草稿、附件或引用時重試。',
    unknown: '傳送結果待確認', failed: '訊息未傳送', checking: '正在確認傳送結果',
    offline: '等待連線恢復',
    remove: '刪除失敗訊息', cancel: '取消傳送', check: '確認傳送結果',
    edit: '編輯後重送', busy: '正在更新訊息', diagnostics: '傳送詳情',
    editUnsent: '編輯', removeUnsent: '刪除未傳送的訊息',
    failedDetail: '可以編輯後重新傳送。刪除這則訊息不會停止正在進行的回覆。',
    unknownDetail: '這則訊息可能已送達。再次傳送前，請先確認傳送結果。',
    retryDetail: '連線可用時會自動再次確認傳送結果。',
    savedDetail: '已儲存在此裝置上，將在可以傳送時繼續傳送。',
    updateError: '無法更新這則訊息，已儲存的內容仍然保留。',
    draftBlocked: '請先完成或清空輸入框中的草稿、附件和引用，再編輯這則訊息。',
    draftReady: '已恢復到輸入框，可編輯後傳送。失敗訊息會保留，直到你刪除它。',
  },
})) satisfies UiCatalog<SessionLocalCopy>;

export function getSessionLocalCopy(locale: UiLocale): SessionLocalCopy { return catalog[locale]; }
