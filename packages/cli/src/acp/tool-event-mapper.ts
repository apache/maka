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

import { createHash } from 'node:crypto';
import {
  RequestError,
  type SessionUpdate,
  type ToolCallContent,
  type ToolKind,
} from '@agentclientprotocol/sdk';
import {
  decodeToolStepProgress,
  type SessionEvent,
  type ToolActivityKind,
  type ToolResultContent,
} from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import { projectToolArgsPreview } from '@maka/core/tool-quiet-preview';
import { toolResultActivityStatus } from '@maka/core/tool-result-status';
import type { InteractionPendingSnapshot, InteractionSnapshot } from '@maka/runtime-host/protocol';
import { BoundedChunkBuffer } from '../bounded-chunk-buffer.js';
import { formatToolResultContent } from '../pi-transcript-format.js';

// Presentation limits, not Host execution/admission limits. The per-tool values
// match the existing TUI buffers; the aggregate also bounds concurrent tools.
const TOOL_CHARS = 64 * 1024;
const TOOL_CHUNKS = 512;
const PROMPT_CHARS = 1024 * 1024;
const PROMPT_TOOL_IDENTITIES = 4096;
const AUXILIARY_CHARS = 4096;

type ToolEvent = Extract<
  SessionEvent,
  {
    type:
      | 'tool_start'
      | 'tool_output_delta'
      | 'tool_progress'
      | 'tool_result_preview'
      | 'tool_result';
  }
>;
type Output = { seq: number; stream: string; chunk: string; redacted: boolean };
type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
interface ToolState {
  id: string;
  turnId: string;
  title: string;
  name?: string;
  kind: ToolKind;
  status: ToolStatus;
  terminal: boolean;
  authoritative: boolean;
  created: boolean;
  output?: BoundedChunkBuffer<Output>;
  progress?: BoundedChunkBuffer<string>;
  inputPreview: string;
  preview: string;
  meta: Record<string, unknown>;
  lastDigest?: string;
  resultDigest?: string;
  callDigest?: string;
  retainedChars: number;
  synthetic?: boolean;
}

/** Tool presentation only. Turn completion remains the Session channel's decision. */
export class AcpToolEventMapper {
  readonly #tools = new Map<string, ToolState>();
  #retainedChars = 0;
  constructor(readonly notify: (update: SessionUpdate) => Promise<void>) {}

  async accept(event: ToolEvent): Promise<void> {
    const tool = this.#ensure(event.turnId, event.toolUseId);
    switch (event.type) {
      case 'tool_start':
        tool.name = event.toolName;
        tool.title = bounded(event.displayName ?? event.toolName, AUXILIARY_CHARS).text;
        tool.kind = toolKind(event.activityKind);
        if (event.operationId) tool.meta.operationId = event.operationId;
        if (event.stepId) tool.meta.stepId = event.stepId;
        if (!tool.terminal) {
          const preview =
            event.args === undefined
              ? event.argsPreview
              : projectToolArgsPreview(event.toolName, event.args);
          tool.inputPreview =
            preview === undefined ? '' : bounded(JSON.stringify(preview), AUXILIARY_CHARS).text;
        }
        await this.#publishCall(tool, rawInput(event.toolName, event.args));
        return;
      case 'tool_output_delta':
        if (tool.terminal) return;
        tool.output ??= outputBuffer();
        if (!tool.output.append(event)) return;
        tool.meta.redacted = tool.meta.redacted === true || event.redacted;
        if (event.seq >= ((tool.meta.output as { sequence: number } | undefined)?.sequence ?? -1)) {
          tool.meta.output = {
            sequence: event.seq,
            stream: event.stream,
            redacted: event.redacted,
          };
        }
        break;
      case 'tool_progress':
        if (tool.terminal) return;
        tool.progress ??= progressBuffer();
        tool.progress.append(
          typeof event.chunk === 'string'
            ? event.chunk
            : `[${event.chunk.kind}] ${event.chunk.text}`,
        );
        {
          const progress = decodeToolStepProgress(event.chunk);
          if (progress) tool.meta.progress = progress;
        }
        break;
      case 'tool_result_preview':
        if (tool.terminal) return;
        tool.preview = bounded(`Preview: ${JSON.stringify(event.content)}`, AUXILIARY_CHARS).text;
        break;
      case 'tool_result':
        if (tool.authoritative && event.contentOmitted) return;
        if (event.operationId) tool.meta.operationId = event.operationId;
        await this.#result(
          tool,
          event.isError,
          event.content,
          event.durationMs,
          event.contentOmitted === true,
        );
        return;
    }
    await this.#publish(tool);
  }

  async acceptMessage(message: StoredMessage): Promise<void> {
    if (message.type === 'tool_call') {
      const tool = this.#ensure(message.turnId, message.id);
      tool.title = bounded(message.displayName ?? message.toolName, AUXILIARY_CHARS).text;
      tool.name = message.toolName;
      tool.kind = toolKind(message.activityKind);
      if (message.stepId) tool.meta.stepId = message.stepId;
      if (!tool.terminal) {
        const preview = projectToolArgsPreview(message.toolName, message.args);
        tool.inputPreview =
          preview === undefined ? '' : bounded(JSON.stringify(preview), AUXILIARY_CHARS).text;
      }
      await this.#publishCall(tool, rawInput(message.toolName, message.args));
    } else if (message.type === 'tool_result') {
      await this.#result(
        this.#ensure(message.turnId, message.toolUseId),
        message.isError,
        message.content,
        message.durationMs,
        false,
      );
    }
  }

  async pendingInteraction(pending: InteractionPendingSnapshot): Promise<void> {
    const tool = this.#ensure(pending.turnId, interactionToolId(pending));
    if (pending.request.kind === 'sandbox_boundary') tool.synthetic = true;
    if (tool.terminal) return;
    tool.status = 'pending';
    tool.meta.interaction = {
      id: pending.interactionId,
      kind: pending.request.kind,
      status: 'pending',
    };
    if (!tool.name) tool.title = `Awaiting ${pending.request.kind.replaceAll('_', ' ')}`;
    await this.#publish(tool);
  }

  async resolvedInteraction(
    resolved: InteractionSnapshot,
    pending: InteractionPendingSnapshot,
  ): Promise<void> {
    if (resolved.status === 'pending') return;
    const tool = this.#ensure(pending.turnId, interactionToolId(pending));
    if (pending.request.kind === 'sandbox_boundary') tool.synthetic = true;
    const outcome = resolved.outcome;
    tool.meta.interaction = {
      id: pending.interactionId,
      kind: pending.request.kind,
      status: resolved.status,
      ...(outcome.kind === 'closure' ? { reason: outcome.reason } : {}),
      ...('decision' in outcome ? { decision: outcome.decision } : {}),
      ...('action' in outcome ? { action: outcome.action } : {}),
    };
    if (!tool.terminal) {
      if (pending.request.kind === 'sandbox_boundary') {
        tool.terminal = true;
        tool.status =
          outcome.kind === 'sandbox_boundary_decision' && outcome.decision === 'allow'
            ? 'completed'
            : 'failed';
      } else tool.status = 'in_progress';
    }
    const closure =
      outcome.kind === 'closure' ? `Interaction closed: ${outcome.reason}` : undefined;
    if (closure && !tool.terminal) {
      tool.progress ??= progressBuffer();
      tool.progress.append(closure);
    }
    await this.#publish(
      tool,
      closure && pending.request.kind === 'sandbox_boundary'
        ? { content: textContent(closure) }
        : {},
    );
    if (tool.terminal) this.#release(tool);
  }

  /** Called only after authoritative turn settlement and transcript reconciliation. */
  async finishTools(
    turnId: string,
    terminalStatus: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    let missingResult = false;
    for (const tool of this.#tools.values()) {
      if (tool.turnId !== turnId || tool.authoritative) continue;
      if (!tool.terminal) {
        tool.terminal = true;
        tool.status = 'failed';
        tool.meta.hostStatus = 'interrupted';
        await this.#publish(tool, {
          content: textContent('Tool interrupted: the turn ended without a result.'),
        });
      }
      if (terminalStatus === 'completed' && !tool.synthetic) missingResult = true;
      this.#release(tool);
    }
    if (missingResult)
      throw projectionError(
        'tool_result_missing',
        'Runtime Host completed the turn without an authoritative tool result',
      );
  }

  #ensure(turnId: string, id: string): ToolState {
    let tool = this.#tools.get(id);
    if (tool && tool.turnId !== turnId)
      throw projectionError('tool_identity_changed', 'A tool identity changed its turn');
    if (!tool) {
      if (this.#tools.size >= PROMPT_TOOL_IDENTITIES)
        throw projectionError(
          'tool_presentation_capacity',
          'ACP tool identity presentation limit exceeded',
        );
      tool = {
        id,
        turnId,
        title: id,
        kind: 'other',
        status: 'in_progress',
        terminal: false,
        authoritative: false,
        created: false,
        inputPreview: '',
        preview: '',
        meta: {},
        retainedChars: 0,
      };
      this.#tools.set(id, tool);
    }
    return tool;
  }

  async #result(
    tool: ToolState,
    isError: boolean,
    result: ToolResultContent,
    durationMs: number | undefined,
    omitted: boolean,
  ): Promise<void> {
    const resultDigest = digestValue({
      isError,
      result: omitted ? null : result,
      durationMs,
      omitted,
    });
    if (tool.resultDigest === resultDigest) return;
    tool.terminal = true;
    const hostStatus = toolResultActivityStatus(isError, omitted ? undefined : result);
    tool.status = hostStatus === 'completed' ? 'completed' : 'failed';
    tool.meta.hostStatus = hostStatus;
    if (durationMs !== undefined) tool.meta.durationMs = durationMs;
    tool.meta.resultPending = omitted;
    if (omitted) {
      // content omission is a status signal. Preserve the client's existing content.
      await this.#publish(tool);
    } else {
      tool.authoritative = true;
      const presentation = bounded(formatToolResultContent(result), TOOL_CHARS);
      const raw = JSON.stringify(result);
      tool.meta.truncated = presentation.dropped > 0;
      tool.meta.droppedChars = presentation.dropped;
      await this.#publish(tool, {
        content: textContent(presentation.text),
        ...(raw.length <= TOOL_CHARS && presentation.dropped === 0 ? { rawOutput: result } : {}),
      });
    }
    tool.resultDigest = resultDigest;
    this.#release(tool);
  }

  async #publishCall(tool: ToolState, input: { rawInput?: unknown }): Promise<void> {
    const digest = digestValue({
      title: tool.title,
      name: tool.name,
      kind: tool.kind,
      input,
      preview: tool.inputPreview,
      stepId: tool.meta.stepId,
      operationId: tool.meta.operationId,
    });
    if (tool.callDigest === digest) return;
    await this.#publish(tool, input);
    tool.callDigest = digest;
  }

  #release(tool: ToolState): void {
    tool.output = undefined;
    tool.progress = undefined;
    tool.inputPreview = '';
    tool.preview = '';
    this.#account(tool);
  }

  async #publish(
    tool: ToolState,
    extra: { content?: ToolCallContent[]; rawInput?: unknown; rawOutput?: unknown } = {},
  ): Promise<void> {
    const fixedChars = fixedStateChars(tool);
    // Keep recent progress and use the remaining per-tool budget for output.
    tool.progress?.trimTo(Math.min(AUXILIARY_CHARS, TOOL_CHARS - fixedChars), TOOL_CHUNKS);
    tool.output?.trimTo(
      TOOL_CHARS - fixedChars - (tool.progress?.charLength ?? 0),
      TOOL_CHUNKS - (tool.progress?.length ?? 0),
    );
    this.#account(tool);
    if (this.#retainedChars > PROMPT_CHARS)
      throw projectionError(
        'tool_presentation_capacity',
        'ACP aggregate tool presentation limit exceeded',
      );
    const dropped = (tool.output?.droppedChars ?? 0) + (tool.progress?.droppedChars ?? 0);
    const content: ToolCallContent[] = [];
    if (tool.inputPreview)
      content.push(...textContent(`Input preview (not full input): ${tool.inputPreview}`));
    if (dropped) content.push(...textContent(`[${dropped} earlier output characters truncated]`));
    for (const output of tool.output?.values() ?? []) {
      content.push({
        type: 'content',
        content: {
          type: 'text',
          text: `[${output.stream}]${output.redacted ? ' [redacted]' : ''} ${output.chunk}`,
          _meta: {
            maka: { sequence: output.seq, stream: output.stream, redacted: output.redacted },
          },
        },
      });
    }
    for (const progress of tool.progress?.values() ?? [])
      content.push(...textContent(`Progress: ${progress}`));
    if (tool.preview) content.push(...textContent(tool.preview));
    const update = {
      toolCallId: tool.id,
      title: tool.title,
      kind: tool.kind,
      status: tool.status,
      _meta: {
        maka: {
          turnId: tool.turnId,
          ...(tool.name ? { toolName: tool.name } : {}),
          ...tool.meta,
          ...(!tool.terminal ? { truncated: dropped > 0, droppedChars: dropped } : {}),
        },
      },
      ...(!tool.terminal ? { content } : {}),
      ...extra,
    };
    const digest = digestValue(update);
    if (tool.lastDigest === digest) return;
    await this.notify(
      tool.created
        ? { sessionUpdate: 'tool_call_update', ...update }
        : { sessionUpdate: 'tool_call', ...update },
    );
    tool.created = true;
    tool.lastDigest = digest;
  }

  #account(tool: ToolState): void {
    const chars =
      fixedStateChars(tool) + (tool.output?.charLength ?? 0) + (tool.progress?.charLength ?? 0);
    this.#retainedChars += chars - tool.retainedChars;
    tool.retainedChars = chars;
  }
}

function fixedStateChars(tool: ToolState): number {
  return (
    tool.inputPreview.length +
    tool.preview.length +
    tool.title.length +
    (tool.name?.length ?? 0) +
    JSON.stringify(tool.meta).length
  );
}

function digestValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function interactionToolId(pending: InteractionPendingSnapshot): string {
  return pending.request.kind === 'sandbox_boundary'
    ? pending.interactionId
    : pending.request.toolUseId;
}

function rawInput(toolName: string, args: unknown): { rawInput?: unknown } {
  // The shared transcript intentionally projects these two tools' arguments.
  if (args === undefined || toolName === 'WriteStdin' || toolName === 'todo_write') return {};
  return JSON.stringify(args).length <= TOOL_CHARS ? { rawInput: args } : {};
}

function bounded(text: string, max: number): { text: string; dropped: number } {
  if (text.length <= max) return { text, dropped: 0 };
  const suffix = '\n[Result truncated]';
  let length = max - suffix.length;
  const before = text.charCodeAt(length - 1);
  if (before >= 0xd800 && before <= 0xdbff) length -= 1;
  return { text: `${text.slice(0, length)}${suffix}`, dropped: text.length - length };
}

function textContent(text: string): ToolCallContent[] {
  return [{ type: 'content', content: { type: 'text', text } }];
}

function outputBuffer(): BoundedChunkBuffer<Output> {
  return new BoundedChunkBuffer({
    maxChars: TOOL_CHARS,
    maxChunks: TOOL_CHUNKS,
    textOf: (chunk) => chunk.chunk,
    withText: (chunk, text) => ({ ...chunk, chunk: text }),
    sequence: (chunk) => chunk.seq,
  });
}

function progressBuffer(): BoundedChunkBuffer<string> {
  return new BoundedChunkBuffer({
    maxChars: TOOL_CHARS,
    maxChunks: TOOL_CHUNKS,
    textOf: (chunk) => chunk,
    withText: (_chunk, text) => text,
  });
}

function toolKind(kind: ToolActivityKind | undefined): ToolKind {
  switch (kind) {
    case 'read':
      return 'read';
    case 'search':
    case 'websearch':
    case 'explore':
      return 'search';
    case 'webfetch':
      return 'fetch';
    case 'edit':
      return 'edit';
    case 'command':
      return 'execute';
    default:
      return 'other';
  }
}

function projectionError(code: string, message: string): RequestError {
  return RequestError.internalError({ source: 'adapter', code }, message);
}
