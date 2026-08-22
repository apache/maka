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

import {
  TOOL_OUTPUT_DELTA_MAX_CHARS,
  type ToolOutputDeltaEvent,
  type ToolOutputStream,
} from '@maka/core/events';
import { redactSecrets } from '@maka/core/redaction';

const REDACTION_TAIL_CHARS = 256;

export interface ToolOutputDeltaEmitterInput {
  sessionId: string;
  turnId: string;
  toolUseId: string;
  newId: () => string;
  now: () => number;
  push: (event: ToolOutputDeltaEvent) => void;
  origin?: 'provider' | 'code_mode';
  modelVisibility?: 'visible' | 'hidden';
  parentToolCallId?: string;
  parentOperationId?: string;
}

export interface ToolOutputDeltaEmitter {
  emit(stream: ToolOutputStream, chunk: string): void;
  flush(): void;
}

export function createToolOutputDeltaEmitter(
  input: ToolOutputDeltaEmitterInput,
): ToolOutputDeltaEmitter {
  let seq = 0;
  const buffers: Record<ToolOutputStream, string> = {
    stdout: '',
    stderr: '',
  };

  function pushSanitized(stream: ToolOutputStream, raw: string): void {
    if (raw.length === 0) return;
    const redacted = redactSecrets(raw);
    for (const chunk of chunkByCodepoint(redacted, TOOL_OUTPUT_DELTA_MAX_CHARS)) {
      const now = input.now();
      input.push({
        type: 'tool_output_delta',
        id: input.newId(),
        sessionId: input.sessionId,
        turnId: input.turnId,
        ts: now,
        toolCallId: input.toolUseId,
        toolUseId: input.toolUseId,
        seq: ++seq,
        stream,
        chunk,
        redacted: redacted !== raw,
        createdAt: now,
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
        ...(input.modelVisibility !== undefined ? { modelVisibility: input.modelVisibility } : {}),
        ...(input.parentToolCallId !== undefined
          ? { parentToolCallId: input.parentToolCallId }
          : {}),
        ...(input.parentOperationId !== undefined
          ? { parentOperationId: input.parentOperationId }
          : {}),
      });
    }
  }

  function flushStream(stream: ToolOutputStream, final: boolean): void {
    let buffer = buffers[stream];
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) break;
      const ready = buffer.slice(0, newlineIndex + 1);
      buffer = buffer.slice(newlineIndex + 1);
      pushSanitized(stream, ready);
    }

    while (buffer.length > TOOL_OUTPUT_DELTA_MAX_CHARS + REDACTION_TAIL_CHARS) {
      const readyLength = Math.min(
        TOOL_OUTPUT_DELTA_MAX_CHARS - REDACTION_TAIL_CHARS,
        buffer.length - REDACTION_TAIL_CHARS,
      );
      const ready = buffer.slice(0, readyLength);
      buffer = buffer.slice(readyLength);
      pushSanitized(stream, ready);
    }

    if (final && buffer.length > 0) {
      pushSanitized(stream, buffer);
      buffer = '';
    }
    buffers[stream] = buffer;
  }

  return {
    emit(stream, chunk) {
      if (chunk.length === 0) return;
      buffers[stream] += chunk;
      flushStream(stream, false);
    },
    flush() {
      flushStream('stdout', true);
      flushStream('stderr', true);
    },
  };
}

function chunkByCodepoint(value: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const char of value) {
    if (current.length + char.length > maxChars && current.length > 0) {
      chunks.push(current);
      current = '';
    }
    current += char;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
