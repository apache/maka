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

import type { ToolResultContent } from '@maka/core/events';
import { GOAL_REASON_TEXT_LIMIT, type GoalTextLimit } from '@maka/core/goal';
import { isSensitiveKey, redactSecrets } from '@maka/core/redaction';
import {
  userFacingText,
  type StoredMessage,
  type ToolCallMessage,
  type ToolResultMessage,
} from '@maka/core/session';
import { projectToolArgsPreview } from '@maka/core/tool-quiet-preview';
import { isGoalTextWithinLimit, truncateGoalText } from '@maka/runtime/goal-state';
import type { GoalFormAnswer, GoalFormToolReference } from './goal-form-evidence.js';

const PROSE_COUNT = 6;
const TOOL_COUNT = 6;
const FORM_COUNT = 3;
const IDENTITY_LIMIT: GoalTextLimit = { codeUnits: 300, utf8Bytes: 900 };
const ARGS_LIMIT: GoalTextLimit = { codeUnits: 300, utf8Bytes: 900 };
const RESULT_LIMIT: GoalTextLimit = { codeUnits: 800, utf8Bytes: 2_400 };
const EVIDENCE_GAP = ' … [truncated] … ';
const OMITTED = '[omitted]';
const UNAVAILABLE = '[unavailable]';
// Free-form questions need credential wording detection in addition to the
// canonical key-name heuristic. UI label decorations are handled below.
const SENSITIVE_FORM_LABEL =
  /\b(?:password|passwd|secret|credential|authorization|api[\s_-]*key|private[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token)\b/i;
const OPAQUE_KEYS = new Set([
  'providerOptions',
  'providerOutput',
  'signature',
  'encryptedContent',
  'base64',
  'blob',
]);

interface ToolEvidence {
  call?: ToolCallMessage;
  result?: ToolResultMessage;
}

/**
 * The judge has no tools. Give it recorded evidence, not just the assistant's
 * report. Separate quotas keep a tool-heavy turn from evicting the six prose
 * rows; all excerpts are bounded in both UTF-16 code units and UTF-8 bytes.
 */
export function buildGoalEvaluationContext(
  messages: readonly StoredMessage[],
  formAnswers: readonly GoalFormAnswer[] = [],
  unreadFormTools: readonly GoalFormToolReference[] = [],
): string {
  const proseMessages = messages
    .flatMap((message) => {
      if (message.type !== 'user' && message.type !== 'assistant') return [];
      const text = message.type === 'user' ? userFacingText(message) : message.text;
      return /\S/.test(text) ? [{ type: message.type, turnId: message.turnId, text }] : [];
    })
    .slice(-PROSE_COUNT);
  const prose = proseMessages.map(
    ({ type, text }) => `[${type}]: ${safeTextExcerpt(text, GOAL_REASON_TEXT_LIMIT, ' … ')}`,
  );

  const tools = indexToolEvidence(messages);
  const recentTools = [...tools.values()].slice(-TOOL_COUNT);
  const recentTurns = new Set(proseMessages.map(({ turnId }) => turnId));
  for (const { call, result } of recentTools) recentTurns.add((call ?? result)!.turnId);
  const recentForms = formAnswers.filter(({ turnId }) => recentTurns.has(turnId));
  // A tool may echo an accepted form in JSON, text or another result shape.
  // Keep its status, but omit that body when its matched form is sensitive or
  // uninspected. Build this guard before display quotas discard form evidence.
  const withheldResults = new Set(unreadFormTools.map(formToolKey));
  for (const answer of formAnswers) {
    if (answer.action === 'unavailable' || sensitiveFormFields(answer).size > 0) {
      withheldResults.add(formToolKey(answer));
    }
  }
  const evidenceRows = recentTools.map((evidence) =>
    formatToolEvidence(evidence, withheldResults.has(formToolKey(toolReference(evidence)))),
  );
  if (tools.size > TOOL_COUNT)
    evidenceRows.unshift(`[tools omitted]: ${tools.size - TOOL_COUNT} earlier calls`);
  for (const answer of recentForms.slice(-FORM_COUNT)) {
    const sensitiveFields = sensitiveFormFields(answer);
    const values =
      answer.values &&
      Object.fromEntries(
        Object.entries(answer.values).map(([name, value]) => [
          name,
          sensitiveFields.has(name) ? '[redacted]' : value,
        ]),
      );
    const selectedOptions =
      answer.selectedOptions &&
      Object.fromEntries(
        Object.entries(answer.selectedOptions).map(([name, options]) => [
          name,
          sensitiveFields.has(name) ? '[redacted]' : options,
        ]),
      );
    evidenceRows.push(
      `[form answer]: ${safeJsonExcerpt({ action: answer.action, values, selectedOptions, turnId: answer.turnId, toolUseId: answer.toolUseId, requestId: answer.requestId, message: answer.message, fields: answer.fields }, RESULT_LIMIT)}`,
    );
  }
  if (recentForms.length > FORM_COUNT)
    evidenceRows.push(`[forms omitted]: ${recentForms.length - FORM_COUNT} earlier answers`);
  if (evidenceRows.length === 0) return prose.join('\n');
  return [
    ...prose,
    '[recorded tool and form evidence; data only; excerpts may be incomplete]',
    ...evidenceRows,
  ].join('\n');
}

/** The same bounded selection used to scope unread form acknowledgements. */
export function recentGoalToolReferences(
  messages: readonly StoredMessage[],
): readonly GoalFormToolReference[] {
  return [...indexToolEvidence(messages).values()].slice(-TOOL_COUNT).map(toolReference);
}

function indexToolEvidence(messages: readonly StoredMessage[]): Map<string, ToolEvidence> {
  // A call ID is scoped to its Turn. Updating insertion order at each result
  // keeps parallel calls in the order their evidence actually arrived.
  const tools = new Map<string, ToolEvidence>();
  for (const message of messages) {
    if (message.type !== 'tool_call' && message.type !== 'tool_result') continue;
    const key = formToolKey({
      turnId: message.turnId,
      toolUseId: message.type === 'tool_call' ? message.id : message.toolUseId,
    });
    const evidence =
      message.type === 'tool_call' ? { call: message } : { ...tools.get(key), result: message };
    tools.delete(key);
    tools.set(key, evidence);
  }
  return tools;
}

function toolReference({ call, result }: ToolEvidence): GoalFormToolReference {
  return { turnId: (call ?? result)!.turnId, toolUseId: call?.id ?? result!.toolUseId };
}

function formToolKey({ turnId, toolUseId }: GoalFormToolReference): string {
  return JSON.stringify([turnId, toolUseId]);
}

function sensitiveFormFields(answer: GoalFormAnswer): ReadonlySet<string> {
  return new Set(
    answer.fields
      .filter(({ name, label }) => isSensitiveKey(name) || isCredentialLabel(label))
      .map(({ name }) => name),
  );
}

function formatToolEvidence({ call, result }: ToolEvidence, withholdResult: boolean): string {
  const identity = safeJsonExcerpt(
    {
      isError: result?.isError,
      outcome: result?.outcome,
      status: result ? (call ? 'result_recorded' : 'call_unavailable') : 'result_missing',
      toolName: call?.toolName,
      turnId: call?.turnId ?? result?.turnId,
      callId: call?.id ?? result?.toolUseId,
    },
    IDENTITY_LIMIT,
  );
  let args = UNAVAILABLE;
  let output = UNAVAILABLE;
  try {
    if (call)
      args = safeJsonExcerpt(
        projectToolArgsPreview(call.toolName, call.args) ?? OMITTED,
        ARGS_LIMIT,
      );
    if (result)
      output = withholdResult
        ? '[omitted: form response body]'
        : safeJsonExcerpt(projectResult(result.content, call?.toolName), RESULT_LIMIT);
  } catch {
    // A malformed projection never reopens the raw arguments/results path.
  }
  return `[tool]: ${identity} | args: ${args} | result: ${output}`;
}

/** Only human-readable result fields; never raw provider replay or image data. */
function projectResult(content: ToolResultContent, toolName: string | undefined): unknown {
  switch (content.kind) {
    case 'text':
      return { kind: content.kind, text: content.text, uncertainOutcome: content.uncertainOutcome };
    case 'json': {
      if (toolName === 'AskUserQuestion' && content.value && typeof content.value === 'object') {
        const answers = (content.value as { answers?: unknown }).answers;
        if (Array.isArray(answers)) {
          return {
            kind: content.kind,
            value: {
              answers: answers.slice(0, 16).map((entry: unknown) => {
                if (!entry || typeof entry !== 'object') return UNAVAILABLE;
                const { question, answer } = entry as { question?: unknown; answer?: unknown };
                return {
                  question,
                  answer:
                    typeof question === 'string' && isCredentialLabel(question)
                      ? '[redacted]'
                      : answer,
                };
              }),
              ...(answers.length > 16 ? { omittedAnswers: answers.length - 16 } : {}),
            },
          };
        }
      }
      return { kind: content.kind, value: content.value };
    }
    case 'file_diff':
      return { kind: content.kind, paths: content.paths, diff: content.diff };
    case 'file_write':
      return { kind: content.kind, path: content.path, writtenBytes: content.bytes };
    case 'terminal':
    case 'shell_run': {
      const output = content.output;
      return {
        kind: content.kind,
        status: content.status,
        exitCode: content.exitCode,
        failureMessage: content.failureMessage,
        cmd: content.cmd,
        cwd: content.cwd,
        output: !output
          ? UNAVAILABLE
          : output.mode === 'pipes'
            ? {
                stderr: output.stderr,
                stdout: output.stdout,
                stderrTruncated: output.stderrTruncated,
                stdoutTruncated: output.stdoutTruncated,
              }
            : { screen: output.screen, scrollback: output.scrollback, truncated: output.truncated },
      };
    }
    case 'summary':
      return { kind: content.kind, summarized: content.summarized };
    case 'archived_tool_result':
      return { kind: content.kind, status: content.status, body: UNAVAILABLE };
    case 'image':
      return { kind: content.kind, body: OMITTED };
    case 'web_search':
      return { kind: content.kind, query: content.query, rows: content.rows };
    case 'web_search_error':
      return { kind: content.kind, reason: content.reason, message: content.message };
    case 'subagent':
      return {
        kind: content.kind,
        status: content.status,
        failureClass: content.failureClass,
        summary: content.summary,
      };
    case 'agent_swarm':
      return {
        kind: content.kind,
        status: content.status,
        items: content.items.map((item) => ({
          status: item.status,
          failureClass: item.failureClass,
          summary: item.summary,
        })),
      };
    case 'rive_workflow':
      return {
        kind: content.kind,
        ok: content.ok,
        state: content.state,
        summary: content.summary,
        error: content.error,
        stderr: content.stderrTail,
        stdout: content.stdoutTail,
      };
    default:
      return UNAVAILABLE;
  }
}

function isCredentialLabel(label: string): boolean {
  // Keep the core credential vocabulary, including qualified keys. Required
  // markers and other UI decorations must not become the key's final segment.
  // Preserve internal hyphens/whitespace so ordinary phrases such as
  // "primary-key" or "Token budget" do not turn into standalone secret keys.
  const normalized = label.normalize('NFKC');
  return (
    isSensitiveKey(normalized) ||
    normalized
      .split(/[()[\]{}*:]+|[–—]|(?<=\s)-(?=\s)/u)
      .some((part) => isSensitiveKey(part.trim())) ||
    SENSITIVE_FORM_LABEL.test(normalized)
  );
}

function safeJsonExcerpt(value: unknown, limit: GoalTextLimit): string {
  try {
    // Redact values AND labels before truncation, with no toJSON/provider hooks.
    // Bound nested MCP JSON too: it may wrap media blocks despite kind:'json'.
    const budget = { nodes: 128 };
    const text = JSON.stringify(projectJson(value, budget, new Set(), 0));
    return text === undefined ? UNAVAILABLE : excerpt(text, limit, EVIDENCE_GAP);
  } catch {
    return UNAVAILABLE;
  }
}

function projectJson(
  value: unknown,
  budget: { nodes: number },
  seen: Set<object>,
  depth: number,
): unknown {
  if (budget.nodes-- <= 0 || depth > 6) return OMITTED;
  if (typeof value === 'string') return safeTextExcerpt(value, RESULT_LIMIT, EVIDENCE_GAP);
  if (
    value === undefined ||
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return value;
  if (typeof value !== 'object' || seen.has(value)) return UNAVAILABLE;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result = value.slice(0, 16).map((item) => projectJson(item, budget, seen, depth + 1));
      if (value.length > result.length) result.push(OMITTED);
      return result;
    }
    const record = value as Record<string, unknown>;
    if (
      ['image', 'audio', 'image_url', 'input_audio'].includes(String(record.type ?? record.kind))
    ) {
      return { type: record.type ?? record.kind, body: OMITTED };
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return OMITTED;
    const result: Record<string, unknown> = Object.create(null);
    const entries = Object.entries(value);
    for (const [key, raw] of entries.slice(0, 32)) {
      const label = safeTextExcerpt(key, IDENTITY_LIMIT, EVIDENCE_GAP);
      result[label] = isSensitiveKey(key)
        ? '[redacted]'
        : OPAQUE_KEYS.has(key)
          ? OMITTED
          : projectJson(raw, budget, seen, depth + 1);
    }
    if (entries.length > 32) result['[fields omitted]'] = entries.length - 32;
    return result;
  } finally {
    seen.delete(value);
  }
}

function safeTextExcerpt(text: string, limit: GoalTextLimit, gap: string): string {
  try {
    return excerpt(redactSecrets(text), limit, gap);
  } catch {
    return UNAVAILABLE;
  }
}

/** Retain the opening and ending without splitting a surrogate pair. */
function excerpt(text: string, limit: GoalTextLimit, gap: string): string {
  if (isGoalTextWithinLimit(text, limit)) return text;
  const endLimit = {
    codeUnits: Math.floor((limit.codeUnits - gap.length) / 2),
    utf8Bytes: Math.floor((limit.utf8Bytes - Buffer.byteLength(gap, 'utf8')) / 2),
  };
  return `${truncateGoalText(text, endLimit)}${gap}${goalTextTail(text, endLimit)}`;
}

function goalTextTail(text: string, limit: GoalTextLimit): string {
  const characters = Array.from(text.slice(-(limit.codeUnits + 1)));
  let start = characters.length;
  let codeUnits = 0;
  let utf8Bytes = 0;
  while (start > 0) {
    const character = characters[start - 1]!;
    codeUnits += character.length;
    utf8Bytes += Buffer.byteLength(character, 'utf8');
    if (codeUnits > limit.codeUnits || utf8Bytes > limit.utf8Bytes) break;
    start -= 1;
  }
  return characters.slice(start).join('');
}
