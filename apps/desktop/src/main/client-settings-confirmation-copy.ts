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
  const zh = locale === 'zh';
  const labels: Record<ClientSettingsChange['key'], readonly [string, string]> = {
    theme: ['Theme', '主题'],
    palette: ['Palette', '配色'],
    uiLocale: ['UI language', '界面语言'],
    runComplete: ['Run-complete notifications', '回答完成通知'],
    keepSystemAwake: ['Keep system awake', '保持系统唤醒'],
  };
  const value = (input: string | boolean | undefined): string => {
    if (!zh) return String(input);
    if (input === true) return '开启';
    if (input === false) return '关闭';
    return String(input);
  };
  return {
    message: zh
      ? '允许 Maka 更新此客户端的设置吗？'
      : "Allow Maka to update this client's settings?",
    detail: changes
      .map(
        (change) =>
          `${labels[change.key][zh ? 1 : 0]}: ${value(change.current)} → ${value(change.next)}`,
      )
      .join('\n'),
    buttons: zh ? ['应用更改', '取消'] : ['Apply changes', 'Cancel'],
  };
}
