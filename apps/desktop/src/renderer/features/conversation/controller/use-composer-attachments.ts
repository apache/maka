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

import { useUiLocale } from '@maka/ui';
import { useComposerAttachments as useSharedComposerAttachments } from '@maka/ui/use-composer-attachments';
import { getDesktopConversationCopy } from '../../../locales/conversation-copy.js';
import { localizedShellErrorMessage } from '../../../locales/shell-copy.js';
export type { ComposerAttachmentService } from '@maka/ui/use-composer-attachments';

/** Desktop localization for the shared staging and preview lifecycle. */
export function useComposerAttachments(options: Omit<Parameters<typeof useSharedComposerAttachments>[0], 'copy' | 'formatError'>) {
  const locale = useUiLocale();
  return useSharedComposerAttachments({
    ...options,
    copy: getDesktopConversationCopy(locale).actions,
    formatError: (error, fallback) => localizedShellErrorMessage(error, fallback, locale),
  });
}
