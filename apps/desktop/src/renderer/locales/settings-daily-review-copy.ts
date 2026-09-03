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
const SETTINGS_DAILY_REVIEW_COPY_BASE = {
  zh: {
    defaultModel: '跟随任务默认',
    saveFailed: '保存每日回顾设置失败',
    aria: '每日回顾',
    unavailable: '当前版本无法读取每日回顾设置。',
    loadFailed: error => `读取每日回顾设置失败：${error}`,
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
    modelHelp: '未指定时跟随当前任务的默认模型。'
  },
  en: {
    defaultModel: 'Follow task default',
    saveFailed: 'Failed to save Daily Review settings',
    aria: 'Daily Review',
    unavailable: 'Daily Review settings are unavailable in this build.',
    loadFailed: error => `Failed to load Daily Review settings: ${error}`,
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
    modelHelp: 'Follows the current task default when unspecified.'
  }
} satisfies Omit<UiCatalog<DailyReviewSettingsCopy>, 'ko'>;
const SETTINGS_DAILY_REVIEW_COPY = {
  ...SETTINGS_DAILY_REVIEW_COPY_BASE,
  ko: {
    defaultModel: "작업 기본값 따르기",
    saveFailed: "일일 검토 설정을 저장하지 못했습니다.",
    aria: "일일 검토",
    unavailable: "이 빌드에서는 일일 검토 설정을 사용할 수 없습니다.",
    loadFailed: error => `일일 검토 설정을 로드하지 못했습니다: ${error}`,
    scheduleTitle: "일정",
    scheduleDescription: "이전 전체 현지 날짜를 자동으로 분석합니다.",
    enabled: "예약된 분석 활성화",
    enabledHelp: "매일 어제의 활동에 대한 분석을 생성합니다.",
    executeTime: "런타임",
    executeTimeHelp: "현지 시간을 24시간 형식으로 사용합니다.",
    executeTimePlaceholder: 'HH:mm',
    executeTimeInvalid: "24시간제 시간을 입력합니다(예: 08:00).",
    analysisTitle: "분석",
    analysisDescription: "고정된 보고서 구조를 생성하는 데 사용되는 모델을 선택합니다.",
    model: "분석 모델",
    modelHelp: "지정되지 않은 경우 현재 작업 기본값을 따릅니다."
  }
} satisfies UiCatalog<DailyReviewSettingsCopy>;
export function getDailyReviewSettingsCopy(locale: UiLocale): DailyReviewSettingsCopy {
  return SETTINGS_DAILY_REVIEW_COPY[locale];
}
