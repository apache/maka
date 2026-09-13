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

export interface TaskReadinessCopy {
  readonly runtime: {
    readonly title: string;
    readonly description: string;
    readonly actionLabel: string;
  };
  readonly workspace: {
    readonly title: string;
    readonly description: string;
    readonly actionLabel: Record<'workspace_picker' | 'retry', string>;
  };
}

const TASK_READINESS_COPY = {
  'zh-CN': {
    runtime: {
      title: 'Maka 运行服务暂时不可用。',
      description: '任务尚未提交。重新检测运行服务后再试。',
      actionLabel: '重新检测',
    },
    workspace: {
      title: '当前任务的工作区不可用。',
      description: '原目录可能已移动、删除或无法访问。请选择可用工作区。',
      actionLabel: { workspace_picker: '选择工作区', retry: '重新检测' },
    },
  },
  'zh-TW': {
    runtime: {
      title: 'Maka 執行服務暫時無法使用。',
      description: '任務尚未送出。重新檢查執行服務後再試。',
      actionLabel: '重新檢查',
    },
    workspace: {
      title: '目前任務的工作區無法使用。',
      description: '原始資料夾可能已移動、刪除或無法存取。請選擇可用的工作區。',
      actionLabel: { workspace_picker: '選擇工作區', retry: '重新檢查' },
    },
  },
  en: {
    runtime: {
      title: 'The Maka runtime is unavailable.',
      description: 'The task was not submitted. Check the runtime again before retrying.',
      actionLabel: 'Check again',
    },
    workspace: {
      title: 'This task workspace is unavailable.',
      description: 'The folder may have moved, been deleted, or become inaccessible. Choose an available workspace.',
      actionLabel: { workspace_picker: 'Choose workspace', retry: 'Check again' },
    },
  },
} satisfies UiCatalog<TaskReadinessCopy>;

export function getTaskReadinessCopy(locale: UiLocale): TaskReadinessCopy {
  return TASK_READINESS_COPY[locale];
}
