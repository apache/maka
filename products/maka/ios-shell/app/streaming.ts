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

import type { AgentPreviewPage } from './bridge';

export interface LiveToolPreview {
  toolUseId: string;
  name: string;
  inputPreview: string;
}

export interface LivePreviewSnapshot {
  runId: string | null;
  thinking: string;
  body: string;
  tools: LiveToolPreview[];
  /** True after PreviewPage::Empty until canonical history replaces the turn. */
  awaitingHistoryHandoff: boolean;
}

interface BytePart {
  key: string;
  kind: 'thinking' | 'body' | 'tool_input';
  ordinal: number;
  toolUseId?: string;
  toolName?: string;
  text: string;
  bytes: number;
}

/** Exact UTF-8 byte length without relying on host TextEncoder availability. */
export function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair encodes as 4 UTF-8 bytes
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Canonical incremental UTF-8 byte-offset preview accumulator aligned with
 * Maka's AgentPreviewPage::Cut wire protocol (offset / totalBytes / revision).
 */
export class LivePreviewAccumulator {
  private identity = '';
  private revision = -1;
  private runId: string | null = null;
  private parts = new Map<string, BytePart>();
  private partOrder: string[] = [];
  private deltaFallback = '';
  private awaitingHistoryHandoff = false;

  reset(): LivePreviewSnapshot {
    this.identity = '';
    this.revision = -1;
    this.runId = null;
    this.parts.clear();
    this.partOrder = [];
    this.deltaFallback = '';
    this.awaitingHistoryHandoff = false;
    return this.snapshot();
  }

  /** Append legacy/direct DeliveryFact::Delta text if no PreviewPage cut is active. */
  applyDelta(runId: string, text: string): LivePreviewSnapshot {
    if (this.runId !== runId) {
      this.reset();
      this.runId = runId;
    }
    this.awaitingHistoryHandoff = false;
    this.deltaFallback += text;
    return this.snapshot();
  }

  /** Apply an incremental AgentPreviewPage::Cut or PreviewPage::Empty frame. */
  applyPreviewPage(page: AgentPreviewPage): LivePreviewSnapshot {
    if (page.kind === 'empty') {
      // Hold rendered fragments until canonical agent.history completes so
      // the streaming bubble hands off seamlessly with zero blank flash.
      this.identity = '';
      this.revision = -1;
      this.awaitingHistoryHandoff = true;
      return this.snapshot();
    }

    const identity = page.hostEpoch + '/' + page.runId + '/' + page.stepId + '/' + page.attemptId;
    if (identity !== this.identity) {
      this.identity = identity;
      this.revision = -1;
      this.runId = page.runId;
      this.parts.clear();
      this.partOrder = [];
      this.deltaFallback = '';
    }
    this.awaitingHistoryHandoff = false;

    if (page.revision < this.revision) {
      return this.snapshot();
    }
    this.revision = page.revision;
    this.runId = page.runId;

    for (const part of page.parts ?? []) {
      const field = part.field;
      if (!field) continue;

      let key: string;
      let kind: BytePart['kind'];
      let ordinal = part.ordinal ?? 0;
      let toolUseId: string | undefined;
      let toolName: string | undefined;

      if (field.kind === 'text') {
        kind = field.textKind === 'thinking' ? 'thinking' : 'body';
        key =
          page.stepId +
          '/' +
          page.attemptId +
          '/' +
          kind +
          '/' +
          String(part.ordinal ?? part.messageId);
      } else if (field.kind === 'tool_input') {
        kind = 'tool_input';
        toolUseId = field.toolUseId;
        toolName = field.name;
        ordinal = part.ordinal ?? 9999;
        key = 'tool/' + field.toolUseId;
      } else {
        continue;
      }

      const prev = this.parts.get(key);
      let nextText: string;
      let nextBytes: number;
      const chunkBytes = utf8ByteLength(part.text);

      if (part.offset === 0) {
        nextText = part.text;
        nextBytes = chunkBytes;
      } else if (prev && prev.bytes === part.offset) {
        nextText = prev.text + part.text;
        nextBytes = part.offset + chunkBytes;
      } else if (prev && part.offset < prev.bytes) {
        // Ignore already-applied overlapping cut slices cleanly.
        continue;
      } else {
        // Resync conservatively if an earlier slice was dropped before join.
        nextText = (prev ? prev.text : '') + part.text;
        nextBytes = part.offset + chunkBytes;
      }

      if (!prev) {
        this.partOrder.push(key);
      }
      this.parts.set(key, {
        key,
        kind,
        ordinal,
        toolUseId,
        toolName,
        text: nextText,
        bytes: nextBytes,
      });
    }

    return this.snapshot();
  }

  /** Complete the handoff once canonical agent.history has refreshed. */
  completeHandoffIfPending(): LivePreviewSnapshot | null {
    if (!this.awaitingHistoryHandoff) return null;
    return this.reset();
  }

  snapshot(): LivePreviewSnapshot {
    const thinkingChunks: string[] = [];
    const bodyChunks: string[] = [];
    const tools: LiveToolPreview[] = [];

    for (const key of this.partOrder) {
      const part = this.parts.get(key);
      if (!part) continue;
      if (part.kind === 'thinking') {
        if (part.text.length > 0) thinkingChunks.push(part.text);
      } else if (part.kind === 'body') {
        if (part.text.length > 0) bodyChunks.push(part.text);
      } else if (part.kind === 'tool_input' && part.toolUseId && part.toolName) {
        tools.push({
          toolUseId: part.toolUseId,
          name: part.toolName,
          inputPreview: part.text.slice(-160),
        });
      }
    }

    const body = bodyChunks.length > 0 ? bodyChunks.join('\n\n') : this.deltaFallback;
    return {
      runId: this.runId,
      thinking: thinkingChunks.join('\n\n'),
      body,
      tools,
      awaitingHistoryHandoff: this.awaitingHistoryHandoff,
    };
  }
}
