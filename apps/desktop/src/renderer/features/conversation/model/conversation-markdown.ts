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

import { renderConversationMarkdown as renderConversationMarkdownCore } from '@maka/core/conversation-markdown';
import type { StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { getShellRemainingCopy } from '../../../locales/shell-remaining-copy.js';

/**
 * Serialize the open conversation to a Markdown document suitable for pasting
 * into Notion / Obsidian / GitHub. The rendering itself lives in core
 * (`renderConversationMarkdown`) so the Desktop clipboard export and the CLI
 * transcript export cannot drift apart again (#5958, #6036 review) — this
 * adapter only carries the locale copy and the light clipboard shape: tool
 * results and thinking stay out, matching the @kenji precedent, and the
 * redactor is the same one the CLI export uses.
 */
export function renderConversationMarkdown(
  sessionName: string,
  messages: readonly StoredMessage[],
  locale: UiLocale,
): string {
  const copy = getShellRemainingCopy(locale).conversationExport;
  return renderConversationMarkdownCore(sessionName, messages, {
    copy: {
      you: copy.you,
      assistant: 'Maka',
      toolCalls: copy.toolCalls,
      thinking: 'Thinking',
      intentSeparator: copy.intentSeparator,
    },
    includeToolResults: false,
    // The clipboard export has always set its exported-at line in italics;
    // keep that shape on the shared renderer (#6036 review).
    exportedAtLine: (isoTimestamp) =>
      `*${copy.exported(
        new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(isoTimestamp),
        ),
      )}*`,
  });
}
