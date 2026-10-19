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

import type { ShippedUiCatalog, UiCatalog, UiLocale } from '@maka/core/ui-locale';

const COPY = {
  en: { chatOptions: 'Chat options', expand: 'Show details', collapse: 'Collapse' },
  'zh-CN': { chatOptions: '聊天选项', expand: '展开详情', collapse: '收起' },
  'zh-TW': { chatOptions: '聊天選項', expand: '展開詳情', collapse: '收起' },
} satisfies ShippedUiCatalog<{ chatOptions: string; expand: string; collapse: string }>;

export function assistantChatCopy(locale: UiLocale) {
  return (COPY as Partial<UiCatalog<typeof COPY.en>>)[locale] ?? COPY.en;
}
