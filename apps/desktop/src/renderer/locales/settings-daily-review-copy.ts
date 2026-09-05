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

export type DailyReviewSettingsCopy = {
  defaultModel: string;
  saveFailed: string;
  aria: string;
  unavailable: string;
  loadFailed(error: string): string;
  scheduleTitle: string;
  scheduleDescription: string;
  enabled: string;
  enabledHelp: string;
  executeTime: string;
  executeTimeHelp: string;
  executeTimePlaceholder: string;
  executeTimeInvalid: string;
  analysisTitle: string;
  analysisDescription: string;
  model: string;
  modelHelp: string;
};

const SETTINGS_DAILY_REVIEW_COPY = {
  'zh-CN': {
    defaultModel: '跟随任务默认',
    saveFailed: '保存每日回顾设置失败',
    aria: '每日回顾',
    unavailable: '当前版本无法读取每日回顾设置。',
    loadFailed: (error) => `读取每日回顾设置失败：${error}`,
    scheduleTitle: '定时分析',
    scheduleDescription: '按本地时间自动分析前一个完整自然日的活动。',
    enabled: '启用定时分析',
    enabledHelp: '每天生成一份昨日活动分析。',
    executeTime: '执行时间',
    executeTimeHelp: '使用 24 小时制的本地时间。',
    executeTimePlaceholder: 'HH:mm',
    executeTimeInvalid: '请输入 24 小时制时间，例如 08:00。',
    analysisTitle: '分析',
    analysisDescription: '选择用于生成固定结构报告的模型。',
    model: '分析模型',
    modelHelp: '未指定时跟随当前任务的默认模型。',
  },
  'zh-TW': {
    defaultModel: '跟隨任務預設',
    saveFailed: '儲存每日回顧設定失敗',
    aria: '每日回顧',
    unavailable: '目前版本無法讀取每日回顧設定。',
    loadFailed: (error) => `讀取每日回顧設定失敗：${error}`,
    scheduleTitle: '定時分析',
    scheduleDescription: '按本地時間自動分析前一個完整自然日的活動。',
    enabled: '啟用定時分析',
    enabledHelp: '每天生成一份昨日活動分析。',
    executeTime: '執行時間',
    executeTimeHelp: '使用 24 小時制的本地時間。',
    executeTimePlaceholder: 'HH:mm',
    executeTimeInvalid: '請輸入 24 小時制時間，例如 08:00。',
    analysisTitle: '分析',
    analysisDescription: '選擇用於生成固定結構報告的模型。',
    model: '分析模型',
    modelHelp: '未指定時跟隨目前任務的預設模型。',
  },
  en: {
    defaultModel: 'Follow task default',
    saveFailed: 'Failed to save Daily Review settings',
    aria: 'Daily Review',
    unavailable: 'Daily Review settings are unavailable in this build.',
    loadFailed: (error) => `Failed to load Daily Review settings: ${error}`,
    scheduleTitle: 'Schedule',
    scheduleDescription: 'Analyze the previous complete local day automatically.',
    enabled: 'Enable scheduled analysis',
    enabledHelp: 'Generate an analysis of yesterday’s activity each day.',
    executeTime: 'Run time',
    executeTimeHelp: 'Uses your local time in 24-hour format.',
    executeTimePlaceholder: 'HH:mm',
    executeTimeInvalid: 'Enter a 24-hour time, for example 08:00.',
    analysisTitle: 'Analysis',
    analysisDescription: 'Choose the model used to generate the fixed report structure.',
    model: 'Analysis model',
    modelHelp: 'Follows the current task default when unspecified.',
  },
} satisfies UiCatalog<DailyReviewSettingsCopy>;

export function getDailyReviewSettingsCopy(locale: UiLocale): DailyReviewSettingsCopy {
  return SETTINGS_DAILY_REVIEW_COPY[locale];
}
