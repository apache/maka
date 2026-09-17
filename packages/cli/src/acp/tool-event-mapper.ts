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
  resultAnnounced: boolean;
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
}

interface ToolCallProjection {
  readonly toolName: string;
  readonly displayName?: string;
  readonly activityKind?: ToolActivityKind;
  readonly args?: unknown;
  readonly argsPreview?: unknown;
  readonly stepId?: string;
  readonly operationId?: string;
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
        await this.#call(tool, event);
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
      await this.#call(tool, message);
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
        // ACP content patches replace the whole card. Keep the output already
        // shown to the client when a resultless tool is interrupted.
        await this.#publish(tool);
      }
      // A live result announcement promises a durable result. A start, delta or
      // progress event alone does not: completed turns can contain unfinished
      // tool calls, and those should remain visible as interrupted cards.
      if (terminalStatus === 'completed' && tool.resultAnnounced) missingResult = true;
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
        resultAnnounced: false,
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
    if (omitted) tool.resultAnnounced = true;
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
      const presentation = bounded(
        formatToolResultContent(result),
        TOOL_CHARS,
        '\n[Result truncated]',
      );
      const raw = JSON.stringify(result);
      tool.meta.resultTruncated = presentation.dropped > 0;
      tool.meta.resultDroppedChars = presentation.dropped;
      await this.#publish(tool, {
        content: textContent(presentation.text),
        ...(raw.length <= TOOL_CHARS && presentation.dropped === 0 ? { rawOutput: result } : {}),
      });
    }
    tool.resultDigest = resultDigest;
    this.#release(tool);
  }

  async #call(tool: ToolState, call: ToolCallProjection): Promise<void> {
    tool.name = call.toolName;
    tool.title = bounded(call.displayName ?? call.toolName, AUXILIARY_CHARS).text;
    tool.kind = toolKind(call.activityKind);
    if (call.operationId) tool.meta.operationId = call.operationId;
    if (call.stepId) tool.meta.stepId = call.stepId;
    if (!tool.terminal) {
      const preview =
        call.args === undefined
          ? call.argsPreview
          : projectToolArgsPreview(call.toolName, call.args);
      tool.inputPreview =
        preview === undefined ? '' : bounded(JSON.stringify(preview), AUXILIARY_CHARS).text;
    }
    await this.#publishCall(tool, rawInput(call.toolName, call.args));
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
    const outputs = tool.output?.values() ?? [];
    let previousSequence = dropped > 0 ? (outputs[0]?.seq ?? 1) - 1 : 0;
    let missingChunks = 0;
    for (const output of outputs) {
      if (output.seq > previousSequence + 1) missingChunks += output.seq - previousSequence - 1;
      previousSequence = output.seq;
    }
    if (missingChunks)
      content.push(
        ...textContent(
          `[${missingChunks} tool output chunk${missingChunks === 1 ? '' : 's'} missing]`,
        ),
      );
    for (const output of outputs) {
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
          ...(!tool.terminal
            ? {
                liveOutputTruncated: dropped > 0 || missingChunks > 0,
                liveOutputDroppedChars: dropped,
                liveOutputMissingChunks: missingChunks,
              }
            : {}),
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

function rawInput(toolName: string, args: unknown): { rawInput?: unknown } {
  // The shared transcript intentionally projects these two tools' arguments.
  if (args === undefined || toolName === 'WriteStdin' || toolName === 'todo_write') return {};
  return JSON.stringify(args).length <= TOOL_CHARS ? { rawInput: args } : {};
}

function bounded(text: string, max: number, suffix = '…'): { text: string; dropped: number } {
  if (text.length <= max) return { text, dropped: 0 };
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
