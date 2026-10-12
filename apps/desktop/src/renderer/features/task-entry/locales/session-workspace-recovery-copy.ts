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
    confirmDescription: '此目录属于一个已归档的项目。是否恢复原项目，并将当前任务的工作区切换到该项目目录？不会创建新任务或自动发送消息。',
    confirmLabel: '恢复并用于当前任务',
    projectUnavailable: '项目目录当前不可用，当前任务的工作区未更改。请重新选择项目目录或选择其他可用项目。',
    restoredPrefix: '项目已恢复，未重新归档。',
    registrationUnconfirmedTitle: '无法确认项目添加结果',
    registrationUnconfirmed: '尚未发起当前任务的工作区切换。请先检查项目列表，再决定是否重试。',
    restoreUnconfirmedTitle: '无法确认项目恢复结果',
    restoreUnconfirmed: '尚未发起当前任务的工作区切换。请先检查项目是否已恢复，再决定是否重试。',
    moveUnconfirmedTitle: '无法确认工作区切换结果',
    moveUnconfirmed: '请先检查当前任务使用的工作区，再决定是否重试；不会自动再次提交切换。',
    refreshFailedTitle: '项目列表刷新失败',
    refreshFailed: '刷新失败不会撤销已完成的项目恢复或工作区切换。请刷新项目列表。',
  },
  'zh-TW': {
    confirmDescription: '此目錄屬於一個已歸檔的專案。是否恢復原專案，並將目前任務的工作區切換至該專案目錄？不會建立新任務或自動傳送訊息。',
    confirmLabel: '恢復並用於目前任務',
    projectUnavailable: '專案目錄目前無法使用，目前任務的工作區未變更。請重新選擇專案目錄或選擇其他可用專案。',
    restoredPrefix: '專案已恢復，未重新歸檔。',
    registrationUnconfirmedTitle: '無法確認專案新增結果',
    registrationUnconfirmed: '尚未發起目前任務的工作區切換。請先檢查專案清單，再決定是否重試。',
    restoreUnconfirmedTitle: '無法確認專案恢復結果',
    restoreUnconfirmed: '尚未發起目前任務的工作區切換。請先檢查專案是否已恢復，再決定是否重試。',
    moveUnconfirmedTitle: '無法確認工作區切換結果',
    moveUnconfirmed: '請先檢查目前任務使用的工作區，再決定是否重試；不會自動再次提交切換。',
    refreshFailedTitle: '專案清單重新整理失敗',
    refreshFailed: '重新整理失敗不會撤銷已完成的專案恢復或工作區切換。請重新整理專案清單。',
  },
  en: {
    confirmDescription: 'This directory belongs to an archived project. Restore the original project and switch this task’s workspace to its directory? This will not create a new task or automatically send a message.',
    confirmLabel: 'Restore and use for this task',
    projectUnavailable: 'The project directory is unavailable. This task’s workspace was not changed. Select the project directory again or choose another available project.',
    restoredPrefix: 'The project was restored and has not been archived again.',
    registrationUnconfirmedTitle: 'Could not confirm project registration',
    registrationUnconfirmed: 'The request to switch this task’s workspace has not been sent. Check the project list before deciding to retry.',
    restoreUnconfirmedTitle: 'Could not confirm project restoration',
    restoreUnconfirmed: 'The request to switch this task’s workspace has not been sent. Check whether the project was restored before deciding to retry.',
    moveUnconfirmedTitle: 'Could not confirm workspace switch',
    moveUnconfirmed: 'Check this task’s current workspace before deciding to retry. The switch will not be retried automatically.',
    refreshFailedTitle: 'Could not refresh the project list',
    refreshFailed: 'A refresh failure does not undo a completed project restoration or workspace switch. Refresh the project list.',
  },
} satisfies UiCatalog<SessionWorkspaceRecoveryCopy>;

export function getSessionWorkspaceRecoveryCopy(locale: UiLocale): SessionWorkspaceRecoveryCopy {
  return COPY_BY_LOCALE[locale];
}
