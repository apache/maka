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

import type { StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { renderConversationMarkdown as renderConversationMarkdownCore } from '@maka/core/conversation-markdown';
import { getShellRemainingCopy } from '../../../locales/shell-remaining-copy.js';

/**
 * Serialize a conversation to a Markdown document suitable for pasting into
 * Notion / Obsidian / GitHub. One section per turn: `## 你` header for the
 * user message, optional `### 工具调用` block enumerating tool calls + their
 * intent, `## Maka` for the assistant answer.
 *
 * Per @kenji's PR86 review, deliberate exclusions:
 * - **thinking block** is never included — that's model working notes, not
 *   the answer. If we ever add an "include thinking" toggle, it must be a
 *   separate opt-in.
 * - **token_usage / permission_decision / tool_result** rows dropped —
 *   operational records, not narrative.
 * - **tool intents** run through `redactSecrets` defensively in case a
 *   model-authored intent happens to echo a path / token.
 * - **assistant text** runs through `redactSecrets` defensively — backend
 *   already redacts at write-time, but a fresh AI-SDK error path that
 *   somehow lands a raw token in `text` shouldn't survive into a clipboard
 *   export that the user is going to paste somewhere public.
 * - **user text** left untouched (the user typed it, they own it).
 */
export function renderConversationMarkdown(sessionName: string, messages: readonly StoredMessage[], locale: UiLocale): string {
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
