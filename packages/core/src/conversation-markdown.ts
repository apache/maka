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
 * The one shared conversation → Markdown renderer (#5958, #6036 review): the
 * Desktop "Export as Markdown" surface and the CLI transcript export call
 * this with their own copy strings instead of keeping two implementations
 * that have already drifted apart once.
 *
 * Rows are emitted in stored order inside a turn — a steering message prints
 * where the user sent it, not grouped ahead of the tool calls it follows —
 * and every model-produced string passes the redactor before reaching the
 * document. Tool-result fences are sized from their body so a result
 * containing ``` cannot close the fence early.
 */

import { redactSecrets } from './redaction.js';
import { userFacingText, type StoredMessage, type ToolResultMessage } from './session.js';

export interface ConversationMarkdownCopy {
  /** Header above each user message, e.g. "You" / "你". */
  you: string;
  /** Header above the assistant answer. */
  assistant: string;
  /** Section header for a run of tool-call rows. */
  toolCalls: string;
  /** Section header for an optional thinking block. */
  thinking: string;
  /** Separator between a tool row and its redacted intent, e.g. " — ". */
  intentSeparator: string;
}

export interface RenderConversationMarkdownOptions {
  copy: ConversationMarkdownCopy;
  /**
   * Everything model-produced (intents, arguments, results, thinking,
   * assistant text) passes through this before reaching the document. Both
   * export surfaces pass the same redactor so one export cannot leak what
   * the other hides (#6036 review). Defaults to the core `redactSecrets`.
   */
  redact?: (text: string) => string;
  /** Model working notes; off by default per the Desktop-export precedent. */
  includeThinking?: boolean;
  /**
   * Render each tool call with its paired result body. The CLI file export
   * turns this on; the Desktop clipboard shape keeps the lighter rows.
   */
  includeToolResults?: boolean;
  /** Render the call's `args` (redacted, single line) next to the tool row. */
  includeToolArguments?: boolean;
  now?: () => number;
  /**
   * Renders the italic "exported at" line under the title. The CLI keeps the
   * ISO default; Desktop passes its locale copy.
   */
  exportedAtLine?: (isoTimestamp: string) => string;
  /**
   * Streaming sink: called once per assembled block (document head, then one
   * chunk per turn). With `emit` the renderer returns '' and the caller owns
   * assembly, so memory stays bounded by one turn regardless of session size
   * (#6036 review).
   */
  emit?: (chunk: string) => void;
}

/**
 * Serialize stored rows to a Markdown document. One section per turn: a
 * `## {copy.you}` header per user message (steering included, in stored
 * order), lazy `### {copy.toolCalls}` blocks carrying each call's redacted
 * intent/arguments and result, and `## {copy.assistant}` for the answer.
 */
export function renderConversationMarkdown(
  sessionName: string,
  messages: readonly StoredMessage[],
  options: RenderConversationMarkdownOptions,
): string {
  const redact = options.redact ?? redactSecrets;
  const chunks: string[] = [];
  const emit = options.emit ?? ((chunk: string) => chunks.push(chunk));

  const exportedLine = (options.exportedAtLine ?? ((iso: string) => `Exported ${iso}`))(
    new Date((options.now ?? Date.now)()).toISOString(),
  );
  emit(`# ${sessionName}\n\n${exportedLine}\n\n`);

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

  for (const turnId of turnOrder) {
    const turnMessages = byTurn.get(turnId) ?? [];
    emit('---\n\n');
    let inToolRun = false;
    // Consecutive assistant steps join into one answer block: the header is
    // per answer, the texts stay in stored step order.
    let assistantTexts: string[] = [];
    let assistantThinkings: string[] = [];
    const flushAssistant = (): void => {
      inToolRun = false;
      if (assistantTexts.length === 0 && assistantThinkings.length === 0) return;
      emit(`## ${options.copy.assistant}\n\n`);
      if (options.includeThinking) {
        const thinking = assistantThinkings.join('\n\n');
        if (thinking.length > 0) {
          emit(`### ${options.copy.thinking}\n\n${redact(thinking)}\n\n`);
        }
      }
      if (assistantTexts.length > 0) {
        emit(`${redact(assistantTexts.join('\n\n'))}\n\n`);
      }
      assistantTexts = [];
      assistantThinkings = [];
    };

    for (const message of turnMessages) {
      if (message.type === 'user') {
        flushAssistant();
        // The user typed it, they own it: no redaction pass on user text.
        emit(`## ${options.copy.you}\n\n${userFacingText(message)}\n\n`);
        continue;
      }
      if (message.type === 'tool_call') {
        flushAssistant();
        if (!inToolRun) {
          emit(`### ${options.copy.toolCalls}\n\n`);
          inToolRun = true;
        }
        const intent = message.intent ? redact(message.intent) : undefined;
        let row = `\`${message.toolName}\`${intent ? `${options.copy.intentSeparator}${intent}` : ''}`;
        if (options.includeToolArguments) {
          const args = redact(safeJsonCompact(message.args));
          if (args.length > 0) row += `${options.copy.intentSeparator}args: ${args}`;
        }
        emit(`${row}\n`);
        continue;
      }
      if (message.type === 'assistant') {
        if (message.text.length > 0) assistantTexts.push(message.text);
        if (message.thinking?.text) assistantThinkings.push(message.thinking.text);
        continue;
      }
      if (message.type === 'tool_result') {
        // Results render at their own stored position: looking them up at the
        // call site would move them ahead of intervening messages, and
        // provider tool-call ids are not session-unique, so a session-wide
        // id map binds results to the wrong turn (#6036 review).
        if (options.includeToolResults) {
          flushAssistant();
          if (!inToolRun) {
            emit(`### ${options.copy.toolCalls}\n\n`);
            inToolRun = true;
          }
          emit(
            renderToolResult(message, redact)
              .map((line) => `${line}\n`)
              .join(''),
          );
        }
        continue;
      }
      // Operational rows (token usage, turn state, permission decisions,
      // system notes) are not something anyone said and stay out.
    }
    flushAssistant();
  }

  return chunks.join('');
}

function renderToolResult(result: ToolResultMessage, redact: (text: string) => string): string[] {
  const label = result.isError ? 'Result (error)' : 'Result (ok)';
  const content = result.content;
  if (content.kind === 'text') {
    return renderResultBody(label, redact(content.text));
  }
  if (content.kind === 'json') {
    return renderResultBody(label, redact(safeJsonPretty(content.value)));
  }
  if (content.kind === 'file_diff') {
    // Paths are user-visible strings too; a secret baked into a filename
    // reaches the label just like it reaches a diff body.
    return renderResultBody(
      redact(`${label} — diff for ${content.paths.join(', ')}`),
      redact(content.diff),
    );
  }
  if (content.kind === 'file_write') {
    return renderResultBody(
      redact(`${label} — Wrote ${content.path} (${content.bytes} bytes)`),
      '',
    );
  }
  if (content.kind === 'archived_tool_result') {
    return renderResultBody(label, `[archived tool result: ${content.status} — ${content.reason}]`);
  }
  if (content.kind === 'terminal') {
    const exit = content.exitCode === undefined ? '' : ` → exit ${content.exitCode}`;
    // The command itself is attacker-visible text and can carry secrets that
    // never touch `output`; the label gets the same treatment as the body.
    return renderResultBody(
      redact(`${label} — ${content.cwd} $ ${content.cmd}${exit}`),
      redact(terminalOutput(content.output)),
    );
  }
  // Structured results (shell_run, web_search, image, …) reach this fallback
  // whole; serializing them verbatim would leak fields the text branch would
  // have redacted.
  return renderResultBody(label, redact(safeJsonPretty(content)));
}

/**
 * One `  - label: body` row, with the body fenced when it is multi-line. The
 * fence grows past any backtick run inside the body so embedded ``` cannot
 * close it early (#6036 review).
 */
function renderResultBody(label: string, body: string): string[] {
  if (body === '') return [`${label}: (empty)`];
  if (!body.includes('\n')) return [`  - ${label}: \`${body}\``];
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
  return [`  - ${label}:`, '', `  ${fence}`, ...indentLines(body), `  ${fence}`];
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function indentLines(text: string): string[] {
  return text.split('\n').map((line) => `  ${line}`);
}

function terminalOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  return safeJsonPretty(output);
}

function safeJsonPretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function safeJsonCompact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
