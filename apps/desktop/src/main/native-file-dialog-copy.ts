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

/**
 * Copy for the native open/save panels. Format names (`Markdown`,
 * `PNG and JPEG`) stay untranslated: they identify a file format, not a
 * product concept. `allFiles` is translated because the panel lists it beside
 * the OS's own localized entries.
 */
interface NativeFileDialogCopy {
  readonly referenceFolder: string;
  readonly addAttachments: string;
  readonly importSkillSource: string;
  readonly importCustomPet: string;
  readonly saveDailyReview: string;
  readonly saveConversation: string;
  readonly allFiles: string;
}

const COPY = {
  'zh-CN': {
    referenceFolder: '引用文件夹',
    addAttachments: '添加附件',
    importSkillSource: '导入 Skill 源文件',
    importCustomPet: '导入自定义宠物',
    saveDailyReview: '保存每日回顾',
    saveConversation: '保存对话',
    allFiles: '所有文件',
  },
  'zh-TW': {
    referenceFolder: '引用資料夾',
    addAttachments: '新增附件',
    importSkillSource: '匯入 Skill 原始檔',
    importCustomPet: '匯入自訂寵物',
    saveDailyReview: '儲存每日回顧',
    saveConversation: '儲存對話',
    allFiles: '所有檔案',
  },
  en: {
    referenceFolder: 'Reference folder',
    addAttachments: 'Add attachments',
    importSkillSource: 'Import Skill source',
    importCustomPet: 'Import custom pet',
    saveDailyReview: 'Save daily review',
    saveConversation: 'Save conversation',
    allFiles: 'All Files',
  },
} satisfies UiCatalog<NativeFileDialogCopy>;

export function nativeFileDialogCopy(locale: UiLocale): NativeFileDialogCopy {
  return COPY[locale];
}
