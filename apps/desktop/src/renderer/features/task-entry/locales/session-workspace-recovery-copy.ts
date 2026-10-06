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

interface SessionWorkspaceRecoveryCopy {
  readonly confirmDescription: string;
  readonly confirmLabel: string;
  readonly projectUnavailable: string;
  readonly restoredPrefix: string;
  readonly registrationUnconfirmedTitle: string;
  readonly registrationUnconfirmed: string;
  readonly restoreUnconfirmedTitle: string;
  readonly restoreUnconfirmed: string;
  readonly moveUnconfirmedTitle: string;
  readonly moveUnconfirmed: string;
  readonly refreshFailedTitle: string;
  readonly refreshFailed: string;
}

const COPY_BY_LOCALE = {
  'zh-CN': {
    confirmDescription: '此目录属于已归档项目。是否恢复原项目，并将当前会话的工作区切换到此项目？不会创建新会话或自动发送消息。',
    confirmLabel: '恢复并用于此会话',
    projectUnavailable: '项目目录当前不可用，会话工作区未更改。请重新定位目录或选择其他可用项目。',
    restoredPrefix: '项目已恢复，未重新归档。',
    registrationUnconfirmedTitle: '无法确认项目添加结果',
    registrationUnconfirmed: '尚未请求切换会话工作区。请先检查项目列表，再决定是否重试。',
    restoreUnconfirmedTitle: '无法确认项目恢复结果',
    restoreUnconfirmed: '尚未请求切换会话工作区。请先检查项目是否已恢复，再决定是否重试。',
    moveUnconfirmedTitle: '无法确认工作区切换结果',
    moveUnconfirmed: '请先检查此会话当前的工作区，再决定是否重试；不会自动再次提交切换。',
    refreshFailedTitle: '项目列表刷新失败',
    refreshFailed: '刷新失败不会撤销已完成的项目恢复或工作区切换。请刷新项目列表。',
  },
  'zh-TW': {
    confirmDescription: '此目錄屬於已封存專案。是否還原原專案，並將目前工作階段的工作區切換至此專案？不會建立新工作階段或自動傳送訊息。',
    confirmLabel: '還原並用於此工作階段',
    projectUnavailable: '專案目錄目前無法使用，工作階段的工作區未變更。請重新定位目錄或選擇其他可用專案。',
    restoredPrefix: '專案已還原，未重新封存。',
    registrationUnconfirmedTitle: '無法確認專案新增結果',
    registrationUnconfirmed: '尚未請求切換工作階段的工作區。請先檢查專案清單，再決定是否重試。',
    restoreUnconfirmedTitle: '無法確認專案還原結果',
    restoreUnconfirmed: '尚未請求切換工作階段的工作區。請先檢查專案是否已還原，再決定是否重試。',
    moveUnconfirmedTitle: '無法確認工作區切換結果',
    moveUnconfirmed: '請先檢查此工作階段目前的工作區，再決定是否重試；不會自動再次提交切換。',
    refreshFailedTitle: '專案清單重新整理失敗',
    refreshFailed: '重新整理失敗不會撤銷已完成的專案還原或工作區切換。請重新整理專案清單。',
  },
  en: {
    confirmDescription: 'This directory belongs to an archived project. Restore the original project and use it as this session’s workspace? This will not create a session or send a message.',
    confirmLabel: 'Restore and use for this session',
    projectUnavailable: 'The project directory is unavailable. The session workspace was not changed. Relocate the directory or choose another available project.',
    restoredPrefix: 'The project was restored and has not been archived again.',
    registrationUnconfirmedTitle: 'Could not confirm project registration',
    registrationUnconfirmed: 'No workspace move was requested. Check the project list before deciding to retry.',
    restoreUnconfirmedTitle: 'Could not confirm project restoration',
    restoreUnconfirmed: 'No workspace move was requested. Check whether the project was restored before deciding to retry.',
    moveUnconfirmedTitle: 'Could not confirm workspace move',
    moveUnconfirmed: 'Check this session’s current workspace before deciding to retry. The move will not be submitted again automatically.',
    refreshFailedTitle: 'Could not refresh projects',
    refreshFailed: 'A refresh failure does not undo a completed project restoration or workspace move. Refresh the project list.',
  },
} satisfies UiCatalog<SessionWorkspaceRecoveryCopy>;

export function getSessionWorkspaceRecoveryCopy(locale: UiLocale): SessionWorkspaceRecoveryCopy {
  return COPY_BY_LOCALE[locale];
}
