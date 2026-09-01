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
import type { ClientSettingsChange } from './client-settings-tools.js';

type ConfirmationCopy = {
  labels: Record<ClientSettingsChange['key'], string>;
  on: string;
  off: string;
  message: string;
  buttons: [string, string];
};

const COPY = {
  'zh-CN': {
    labels: { theme: '主题', palette: '配色', uiLocale: '界面语言', runComplete: '回答完成通知', keepSystemAwake: '保持系统唤醒' },
    on: '开启',
    off: '关闭',
    message: '允许 Maka 更新此客户端的设置吗？',
    buttons: ['应用更改', '取消'],
  },
  'zh-TW': {
    labels: { theme: '主題', palette: '色彩配置', uiLocale: '介面語言', runComplete: '回答完成通知', keepSystemAwake: '保持系統喚醒' },
    on: '開啟',
    off: '關閉',
    message: '允許 Maka 更新此用戶端的設定嗎？',
    buttons: ['套用變更', '取消'],
  },
  en: {
    labels: { theme: 'Theme', palette: 'Palette', uiLocale: 'UI language', runComplete: 'Run-complete notifications', keepSystemAwake: 'Keep system awake' },
    on: 'true',
    off: 'false',
    message: "Allow Maka to update this client's settings?",
    buttons: ['Apply changes', 'Cancel'],
  },
  ko: {
    labels: { theme: '테마', palette: '팔레트', uiLocale: 'UI 언어', runComplete: '응답 완료 알림', keepSystemAwake: '시스템 깨어 있음 유지' },
    on: '켜짐',
    off: '꺼짐',
    message: 'Maka가 이 클라이언트 설정을 업데이트하도록 허용할까요?',
    buttons: ['변경 적용', '취소'],
  },
} satisfies UiCatalog<ConfirmationCopy>;

export function clientSettingsConfirmation(
  changes: readonly ClientSettingsChange[],
  locale: UiLocale,
): { message: string; detail: string; buttons: [string, string] } {
  const copy = COPY[locale];
  const value = (input: string | boolean | undefined): string =>
    input === true ? copy.on : input === false ? copy.off : String(input);
  return {
    message: copy.message,
    detail: changes
      .map((change) => `${copy.labels[change.key]}: ${value(change.current)} → ${value(change.next)}`)
      .join('\n'),
    buttons: [...copy.buttons],
  };
}
