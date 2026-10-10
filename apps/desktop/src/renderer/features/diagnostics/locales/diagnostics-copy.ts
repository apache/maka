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

export interface DiagnosticsCopy {
  readonly previousMainProcessInterruption: {
    readonly title: string;
    readonly description: string;
    readonly copyDiagnostics: string;
  };
}

const COPY_BY_LOCALE = {
  'zh-CN': {
    previousMainProcessInterruption: {
      title: 'Maka 已恢复',
      description: '上次退出未完成。',
      copyDiagnostics: '复制报告',
    },
  },
  'zh-TW': {
    previousMainProcessInterruption: {
      title: 'Maka 已恢復',
      description: '上次退出未完成。',
      copyDiagnostics: '複製報告',
    },
  },
  en: {
    previousMainProcessInterruption: {
      title: 'Maka recovered',
      description: 'The previous shutdown was incomplete.',
      copyDiagnostics: 'Copy report',
    },
  },
} satisfies UiCatalog<DiagnosticsCopy>;

export function getDiagnosticsCopy(locale: UiLocale): DiagnosticsCopy {
  return COPY_BY_LOCALE[locale];
}
