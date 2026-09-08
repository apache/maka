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

import type { UiCatalog } from '@maka/core/ui-locale';
export const workHubLiveCopy = {
  en: { attachmentLimit: 'Attachment count or size exceeds the limit', attachmentUploadFailed: 'Attachment upload did not return a reference', reviewAttachments: 'Please review the attachments.', sendFailed: 'Could not send',
    modelConflict: 'WorkHub changed. Try selecting the model again.',
    undo: 'Undo last change',
    title: 'WorkHub',
    float: 'Float WorkHub',
    dock: 'Return to Maka',
    hide: 'Hide',
    collapseConversation: 'Collapse conversation',
    expandConversation: 'Expand conversation',
    retry: 'Retry',
    older: 'Load earlier messages',
    welcome: 'What can I help with?',
    hint: 'Ask a question, manage your tasks, or ask me to work in Maka.',
    floating: 'WorkHub is in a floating window',
    restore: 'Bring WorkHub back',
  },
  'zh-CN': { attachmentLimit: '附件数量或大小超过限制', attachmentUploadFailed: '附件上传失败', reviewAttachments: '请查看附件。', sendFailed: '发送失败',
    modelConflict: '工作台已更新，请重新选择模型。',
    undo: '撤销上次修改',
    title: '工作台',
    float: '浮出工作台',
    dock: '收回 Maka',
    hide: '隐藏',
    collapseConversation: '收起对话',
    expandConversation: '展开对话',
    retry: '重试',
    older: '加载更早的消息',
    welcome: '有什么可以帮你？',
    hint: '问个问题、管理任务，或让我帮你操作 Maka。',
    floating: '工作台已在浮窗中打开',
    restore: '收回工作台',
  },
  'zh-TW': { attachmentLimit: '附件數量或大小超過限制', attachmentUploadFailed: '附件上傳失敗', reviewAttachments: '請查看附件。', sendFailed: '傳送失敗',
    modelConflict: '工作台已更新，請重新選擇模型。',
    undo: '復原上次修改',
    title: '工作台',
    float: '浮出工作台',
    dock: '收回 Maka',
    hide: '隱藏',
    collapseConversation: '收起對話',
    expandConversation: '展開對話',
    retry: '重試',
    older: '載入更早的訊息',
    welcome: '有什麼可以幫你？',
    hint: '問個問題、管理任務，或讓我幫你操作 Maka。',
    floating: '工作台已在浮動視窗中開啟',
    restore: '收回工作台',
  },
} satisfies UiCatalog<Record<string, string>>;
