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

import { type UiCatalog, type UiLocale, defineShippedUiMessageCatalog, resolveUiMessageCatalog } from '@maka/core/ui-locale';

type PersonalAssistantChatCopy = { avatarLabel: string; typingLabel: string; placeholder: string };
const COPY = resolveUiMessageCatalog(defineShippedUiMessageCatalog<PersonalAssistantChatCopy>()({
  'zh-CN': { avatarLabel: '个人助手头像', typingLabel: '正在输入', placeholder: '聊点什么…' },
  'zh-TW': { avatarLabel: '個人助理頭像', typingLabel: '正在輸入', placeholder: '聊點什麼…' },
  en: { avatarLabel: 'Personal assistant avatar', typingLabel: 'Typing', placeholder: 'Send a message…' },
})) satisfies UiCatalog<PersonalAssistantChatCopy>;

export function getPersonalAssistantChatCopy(locale: UiLocale): PersonalAssistantChatCopy {
  return COPY[locale];
}
