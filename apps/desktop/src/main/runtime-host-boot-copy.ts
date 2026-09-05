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

interface StartupRecoveryCopy {
  storageRoot: {
    title: string;
    message: string;
    detail(workspaceRoot: string): string;
    buttons: [string, string];
  };
  runtimeHost: {
    title: string;
    message(profileName: string): string;
    detail(message: string): string;
    buttons: [string, string, string];
  };
}

const STARTUP_RECOVERY_COPY = {
  'zh-CN': {
    storageRoot: {
      title: 'Maka 工作区需要修复',
      message: 'Maka 无法验证这个工作区。',
      detail: (workspaceRoot) =>
        `系统中的磁盘标识可能发生了变化。仅当这是本机原来的 Maka 工作区、而不是复制出的工作区时，才选择修复。\n\n${workspaceRoot}`,
      buttons: ['修复工作区', '退出'],
    },
    runtimeHost: {
      title: '默认 Runtime Host 无法连接',
      message: (profileName) => `无法连接 ${profileName}`,
      detail: (message) =>
        `${message}\n\n你可以重试、改用 Local 作为默认 Host，或保持当前选择并稍后在设置中处理。`,
      buttons: ['重试', '改用 Local', '保持离线'],
    },
  },
  'zh-TW': {
    storageRoot: {
      title: 'Maka 工作區需要修復',
      message: 'Maka 無法驗證這個工作區。',
      detail: (workspaceRoot) =>
        `系統中的磁碟識別碼可能已變更。只有當這是本機原本的 Maka 工作區，而不是複製的工作區時，才選擇修復。\n\n${workspaceRoot}`,
      buttons: ['修復工作區', '離開'],
    },
    runtimeHost: {
      title: '預設 Runtime Host 無法連線',
      message: (profileName) => `無法連線 ${profileName}`,
      detail: (message) =>
        `${message}\n\n你可以重試、改用 Local 作為預設 Host，或保留目前選擇並稍後在設定中處理。`,
      buttons: ['重試', '改用 Local', '保持離線'],
    },
  },
  en: {
    storageRoot: {
      title: 'Maka workspace needs repair',
      message: 'Maka cannot verify this workspace.',
      detail: (workspaceRoot) =>
        `The disk identity may have changed. Repair only if this is the original Maka workspace on this computer, not a copied workspace.\n\n${workspaceRoot}`,
      buttons: ['Repair Workspace', 'Exit'],
    },
    runtimeHost: {
      title: 'Default Runtime Host is unavailable',
      message: (profileName) => `Could not connect to ${profileName}`,
      detail: (message) =>
        `${message}\n\nRetry, use Local as the default Host, or keep the current selection and resolve it later in Settings.`,
      buttons: ['Retry', 'Use Local', 'Keep Offline'],
    },
  },
  ko: {
    storageRoot: {
      title: 'Maka 작업 공간을 복구해야 합니다',
      message: 'Maka에서 이 작업 공간을 확인할 수 없습니다.',
      detail: (workspaceRoot) =>
        `디스크 식별자가 변경되었을 수 있습니다. 복사한 작업 공간이 아니라 이 컴퓨터의 원래 Maka 작업 공간인 경우에만 복구하세요.\n\n${workspaceRoot}`,
      buttons: ['작업 공간 복구', '종료'],
    },
    runtimeHost: {
      title: '기본 Runtime Host를 사용할 수 없습니다',
      message: (profileName) => `${profileName}에 연결할 수 없습니다`,
      detail: (message) => `${message}\n\n다시 시도하거나 Local을 기본 Host로 사용하거나, 현재 선택을 유지하고 설정에서 나중에 해결하세요.`,
      buttons: ['다시 시도', 'Local 사용', '오프라인 유지'],
    },
  },
} satisfies UiCatalog<StartupRecoveryCopy>;

export function getStartupRecoveryCopy(locale: UiLocale): StartupRecoveryCopy {
  return STARTUP_RECOVERY_COPY[locale];
}
