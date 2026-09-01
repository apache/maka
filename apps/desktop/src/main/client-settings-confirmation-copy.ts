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

import type { UiLocale } from '@maka/core/ui-locale';
import type { ClientSettingsChange } from './client-settings-tools.js';

export function clientSettingsConfirmation(
  changes: readonly ClientSettingsChange[],
  locale: UiLocale,
): { message: string; detail: string; buttons: [string, string] } {
  const labels: Record<ClientSettingsChange['key'], readonly [string, string, string, string]> = {
    theme: ['Theme', '主题', '主題', '테마'],
    palette: ['Palette', '配色', '色彩配置', '팔레트'],
    uiLocale: ['UI language', '界面语言', '介面語言', 'UI 언어'],
    runComplete: ['Run-complete notifications', '回答完成通知', '回答完成通知', '응답 완료 알림'],
    keepSystemAwake: ['Keep system awake', '保持系统唤醒', '保持系統喚醒', '시스템 깨우기 유지'],
  };
  const localeIndex =
    locale === 'en' ? 0 : locale === 'zh-CN' ? 1 : locale === 'zh-TW' ? 2 : 3;
  const value = (input: string | boolean | undefined): string => {
    if (locale === 'en') return String(input);
    if (input === true) {
      return locale === 'zh-CN' ? '开启' : locale === 'zh-TW' ? '開啟' : '켜기';
    }
    if (input === false) {
      return locale === 'zh-CN' ? '关闭' : locale === 'zh-TW' ? '關閉' : '끄기';
    }
    return String(input);
  };
  return {
    message:
      locale === 'en'
        ? "Allow Maka to update this client's settings?"
        : locale === 'zh-CN'
          ? '允许 Maka 更新此客户端的设置吗？'
          : locale === 'zh-TW'
            ? '允許 Maka 更新此用戶端的設定嗎？'
            : 'Maka가 이 클라이언트 설정을 업데이트하도록 허용할까요?',
    detail: changes
      .map(
        (change) =>
          `${labels[change.key][localeIndex]}: ${value(change.current)} → ${value(change.next)}`,
      )
      .join('\n'),
    buttons:
      locale === 'en'
        ? ['Apply changes', 'Cancel']
        : locale === 'zh-CN'
          ? ['应用更改', '取消']
          : locale === 'zh-TW'
            ? ['套用變更', '取消']
            : ['변경 적용', '취소'],
  };
}
