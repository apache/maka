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

/**
 * Export one Session's transcript from persistence as Markdown.
 *
 * The three surfaces each expose a partial slice of a transcript — the Desktop
 * export renders only what the viewport has loaded, and the TUI copy is
 * clipboard-bound — so this is the read-side path that hands out the whole
 * Session: `readMessagesSnapshot` reads every stored row, and the renderer
 * keeps the Desktop export's shape (`## You` / `### Tool calls` / `## Maka`)
 * while restoring what it deliberately drops for the clipboard. Differences,
 * per the #5958 discussion:
 *
 * - **tool results** are included: they are exactly what a debugging reader
 *   needs, and every string that reaches the file passes `redactSecrets`.
 * - **thinking** stays out by default, following the @kenji precedent on the
 *   Desktop export; `includeThinking` is the explicit opt-in.
 * - **operational rows** (token usage, turn state, permission decisions,
 *   system notes, coordination) stay out: they are not something anyone said.
 *
 * No wire, protocol, or storage-schema change: a new reader over data that is
 * already on disk.
 */

import { stat } from 'node:fs/promises';
import type { StoredMessage, ToolResultMessage } from '@maka/core/session';
import { userFacingText } from '@maka/core/session';
import { redactSecrets } from '@maka/core/redaction';
import { createSessionStore } from '@maka/storage/session-store';

export interface ExportSessionTranscriptMarkdownInput {
  workspaceRoot: string;
  sessionId: string;
  /** Model working notes; off by default per the Desktop-export precedent. */
  includeThinking?: boolean;
  now?: () => number;
}

export type ExportSessionTranscriptMarkdownResult =
  | { ok: true; markdown: string; messageCount: number }
  | {
      ok: false;
      reason:
        | { kind: 'workspace_not_found'; workspaceRoot: string }
        | { kind: 'session_not_found' };
    };

export async function exportSessionTranscriptMarkdown(
  input: ExportSessionTranscriptMarkdownInput,
): Promise<ExportSessionTranscriptMarkdownResult> {
  if (!(await isDirectory(input.workspaceRoot))) {
    return {
      ok: false,
      reason: { kind: 'workspace_not_found', workspaceRoot: input.workspaceRoot },
    };
  }

  const store = createSessionStore(input.workspaceRoot);
  try {
    let sessionName: string;
    try {
      sessionName = (await store.readHeaderSnapshot(input.sessionId)).name;
    } catch {
      return { ok: false, reason: { kind: 'session_not_found' } };
    }
    const messages = await store.readMessagesSnapshot(input.sessionId);
    const markdown = renderSessionTranscriptMarkdown(sessionName, messages, {
      includeThinking: input.includeThinking,
      now: input.now,
    });
    return { ok: true, markdown, messageCount: messages.length };
  } finally {
    await store.close?.();
  }
}

export interface RenderSessionTranscriptMarkdownOptions {
  includeThinking?: boolean;
  now?: () => number;
}

/**
 * Serialize stored rows to a Markdown document. One section per turn: a
 * `## You` header for the user message, an optional `### Tool calls` block
 * with each call's redacted intent and result, and `## Maka` for the answer.
 */
export function renderSessionTranscriptMarkdown(
  sessionName: string,
  messages: readonly StoredMessage[],
  options: RenderSessionTranscriptMarkdownOptions = {},
): string {
  const lines: string[] = [];
  lines.push(`# ${sessionName}`);
  lines.push('');
  const exportedAt = new Date((options.now ?? Date.now)());
  lines.push(`*Exported ${exportedAt.toISOString()}*`);
  lines.push('');

  // Group by turnId in encounter order so we preserve narrative flow.
  const turnOrder: string[] = [];
  const byTurn = new Map<string, StoredMessage[]>();
  for (const message of messages) {
    const turnId = message.turnId ?? '__loose';
    if (!byTurn.has(turnId)) {
      byTurn.set(turnId, []);
      turnOrder.push(turnId);
    }
    byTurn.get(turnId)!.push(message);
  }

  const pendingResults = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.type === 'tool_result') pendingResults.set(message.toolUseId, message);
  }

  for (const turnId of turnOrder) {
    const turnMessages = byTurn.get(turnId) ?? [];
    const user = turnMessages.find((message) => message.type === 'user');
    if (user && user.type === 'user') {
      lines.push('---');
      lines.push('');
      lines.push('## You');
      lines.push('');
      lines.push(userFacingText(user));
      lines.push('');
    }

    const toolCalls = turnMessages.filter((message) => message.type === 'tool_call');
    if (toolCalls.length > 0) {
      lines.push('### Tool calls');
      lines.push('');
      for (const call of toolCalls) {
        if (call.type !== 'tool_call') continue;
        const intent = call.intent ? redactSecrets(call.intent) : undefined;
        lines.push(`- \`${call.toolName}\`${intent ? ` — ${intent}` : ''}`);
        const result = pendingResults.get(call.id);
        if (result) {
          lines.push(...renderToolResult(result));
        }
      }
      lines.push('');
    }

    // A turn holds one assistant message per model step; join their text in
    // step order so the export carries the whole answer, not just the first.
    const assistantText = turnMessages
      .flatMap((message) =>
        message.type === 'assistant' && message.text.length > 0 ? [message.text] : [],
      )
      .join('\n\n');
    if (options.includeThinking) {
      const thinking = turnMessages
        .flatMap((message) =>
          message.type === 'assistant' && message.thinking?.text ? [message.thinking.text] : [],
        )
        .join('\n\n');
      if (thinking.length > 0) {
        lines.push('### Thinking');
        lines.push('');
        lines.push(redactSecrets(thinking));
        lines.push('');
      }
    }
    if (assistantText.length > 0) {
      lines.push('## Maka');
      lines.push('');
      lines.push(redactSecrets(assistantText));
      lines.push('');
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

function renderToolResult(result: ToolResultMessage): string[] {
  const label = result.isError ? 'Result (error)' : 'Result (ok)';
  const content = result.content;
  if (content.kind === 'text') {
    return renderResultBody(label, redactSecrets(content.text));
  }
  if (content.kind === 'json') {
    return renderResultBody(label, redactSecrets(safeJson(content.value)));
  }
  if (content.kind === 'file_diff') {
    return renderResultBody(
      `${label} — diff for ${content.paths.join(', ')}`,
      redactSecrets(content.diff),
    );
  }
  if (content.kind === 'file_write') {
    return renderResultBody(label, `Wrote ${content.path} (${content.bytes} bytes)`);
  }
  if (content.kind === 'archived_tool_result') {
    return renderResultBody(label, `[archived tool result: ${content.status} — ${content.reason}]`);
  }
  if (content.kind === 'terminal') {
    const exit = content.exitCode === undefined ? '' : ` → exit ${content.exitCode}`;
    return renderResultBody(
      `${label} — ${content.cwd} $ ${content.cmd}${exit}`,
      redactSecrets(terminalOutput(content.output)),
    );
  }
  return renderResultBody(label, safeJson(content));
}

function renderResultBody(label: string, body: string): string[] {
  if (body === '') return [`${label}: (empty)`];
  if (!body.includes('\n')) return [`  - ${label}: \`${body}\``];
  return [`  - ${label}:`, '', '  ```', ...indent(body), '  ```'];
}

function terminalOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  return safeJson(output);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function indent(text: string): string[] {
  return text.split('\n').map((line) => `  ${line}`);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((metadata) => metadata.isDirectory())
    .catch(() => false);
}
