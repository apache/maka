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
import { userFacingText } from '@maka/core/session';
import { redactSecrets } from '@maka/ui';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';

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
export function renderConversationMarkdown(sessionName: string, messages: StoredMessage[], locale: UiLocale = 'zh'): string {
  const copy = getShellRemainingCopy(locale).conversationExport;
  const lines: string[] = [];
  lines.push(`# ${sessionName}`);
  lines.push('');
  lines.push(`*${copy.exported(new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()))}*`);
  lines.push('');

  // Group by turnId in encounter order so we preserve narrative flow.
  const turnOrder: string[] = [];
  const byTurn = new Map<string, StoredMessage[]>();
  for (const m of messages) {
    const tid = (m as { turnId?: string }).turnId ?? '__loose';
    if (!byTurn.has(tid)) {
      byTurn.set(tid, []);
      turnOrder.push(tid);
    }
    byTurn.get(tid)!.push(m);
  }

  for (const tid of turnOrder) {
    const turnMessages = byTurn.get(tid) ?? [];
    const user = turnMessages.find((m) => m.type === 'user');
    // A turn holds one assistant message per model step; join their text in step
    // order so the export carries the whole answer, not just the first step.
    const assistantText = turnMessages
      .flatMap((m) => (m.type === 'assistant' && m.text.length > 0 ? [m.text] : []))
      .join('\n\n');
    const toolCalls = turnMessages.filter((m) => m.type === 'tool_call');

    if (user && user.type === 'user') {
      lines.push('---');
      lines.push('');
      lines.push(`## ${copy.you}`);
      lines.push('');
      // Prefer displayText when the model text is a composed envelope (skill
      // invocation) so exports match what the user typed, not the injected body.
      lines.push(userFacingText(user));
      lines.push('');
    }

    if (toolCalls.length > 0) {
      lines.push(`### ${copy.toolCalls}`);
      lines.push('');
      for (const call of toolCalls) {
        const c = call as { toolName: string; intent?: string };
        const intent = c.intent ? redactSecrets(c.intent) : undefined;
        const intentSuffix = intent ? `${copy.intentSeparator}${intent}` : '';
        lines.push(`- \`${c.toolName}\`${intentSuffix}`);
      }
      lines.push('');
    }

    if (assistantText.length > 0) {
      lines.push('## Maka');
      lines.push('');
      // Defensive: backend redacts at write-time, but the export landing
      // in the user's clipboard is a high-risk surface — paste destinations
      // are external. Second-layer redaction is cheap insurance.
      lines.push(redactSecrets(assistantText));
      lines.push('');
    }
  }

  return lines.join('\n').trim() + '\n';
}
