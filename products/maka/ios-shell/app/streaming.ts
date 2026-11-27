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

type LiveActivityEntry =
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; tool: LiveToolPreview };

export interface LivePreviewSnapshot {
  runId: string | null;
  thinking: string;
  body: string;
  tools: LiveToolPreview[];
  activity: LiveActivityEntry[];
  /** True after PreviewPage::Empty until canonical history replaces the turn. */
  awaitingHistoryHandoff: boolean;
}

interface BytePart {
  key: string;
  kind: 'thinking' | 'body' | 'tool_input';
  ordinal: number | null;
  startedAt: number;
  arrival: number;
  toolUseId?: string;
  toolName?: string;
  text: string;
  startBytes: number;
  endBytes: number;
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
  private handoffFence?: { identity: string; revision: number };
  private runId: string | null = null;
  private parts = new Map<string, BytePart>();
  private deltaFallback = '';
  private awaitingHistoryHandoff = false;

  reset(): LivePreviewSnapshot {
    this.identity = '';
    this.revision = -1;
    this.handoffFence = undefined;
    this.clearPreview();
    return this.snapshot();
  }

  private clearPreview() {
    this.runId = null;
    this.parts.clear();
    this.deltaFallback = '';
    this.awaitingHistoryHandoff = false;
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
      return this.beginHandoff();
    }

    const identity = page.hostEpoch + '/' + page.runId + '/' + page.stepId + '/' + page.attemptId;
    const fence = this.handoffFence;
    if (fence?.identity === identity && page.revision <= fence.revision) return this.snapshot();
    if (identity !== this.identity) {
      this.identity = identity;
      this.clearPreview();
    } else if (page.revision < this.revision) {
      return this.snapshot();
    }
    this.awaitingHistoryHandoff = false;
    this.revision = page.revision;
    this.runId = page.runId;

    for (const part of page.parts ?? []) {
      const field = part.field;
      if (!field) continue;

      let key: string;
      let kind: BytePart['kind'];
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
        key = 'tool/' + field.toolUseId;
      } else {
        continue;
      }

      const prev = this.parts.get(key);
      let startBytes = part.offset;
      let endBytes = startBytes + utf8ByteLength(part.text);
      let nextText = part.text;

      // Keep a contiguous range: a gap cannot count as bytes we actually hold.
      if (prev && startBytes <= prev.endBytes && endBytes >= prev.startBytes) {
        if (startBytes >= prev.startBytes && endBytes <= prev.endBytes) continue;
        if (startBytes > prev.startBytes) {
          const overlap = prev.endBytes - startBytes;
          nextText =
            prev.text +
            (overlap
              ? Buffer.from(part.text, 'utf8').subarray(overlap).toString('utf8')
              : part.text);
          startBytes = prev.startBytes;
        } else if (endBytes < prev.endBytes) {
          const overlap = endBytes - prev.startBytes;
          nextText += overlap
            ? Buffer.from(prev.text, 'utf8').subarray(overlap).toString('utf8')
            : prev.text;
          endBytes = prev.endBytes;
        }
      }

      this.parts.set(key, {
        key,
        kind,
        ordinal: prev ? prev.ordinal : (part.ordinal ?? null),
        startedAt: prev?.startedAt ?? part.startedAt,
        arrival: prev?.arrival ?? this.parts.size,
        toolUseId,
        toolName,
        text: nextText,
        startBytes,
        endBytes,
      });
    }

    return this.snapshot();
  }

  beginHandoff(): LivePreviewSnapshot {
    this.handoffFence = { identity: this.identity, revision: this.revision };
    this.awaitingHistoryHandoff = true;
    return this.snapshot();
  }

  /** Complete the handoff once canonical agent.history has refreshed. */
  completeHandoffIfPending(): LivePreviewSnapshot | null {
    if (!this.awaitingHistoryHandoff) return null;
    // Keep the cut fence after clearing its payload so a replay cannot resurrect it.
    this.clearPreview();
    return this.snapshot();
  }

  private orderedParts(): BytePart[] {
    const numbered: (BytePart & { ordinal: number })[] = [];
    const unnumbered: BytePart[] = [];
    for (const part of this.parts.values()) {
      if (part.ordinal == null) unnumbered.push(part);
      else numbered.push(part as BytePart & { ordinal: number });
    }
    numbered.sort((a, b) => a.ordinal - b.ordinal || a.arrival - b.arrival);
    const byStart = (a: BytePart, b: BytePart) =>
      a.startedAt - b.startedAt || a.arrival - b.arrival;
    unnumbered.sort(byStart);

    // The wire sends ordinal-less tool inputs after the text parts in a cut.
    // Use their start time to splice them into model order, with arrival as the tie-breaker.
    const ordered: BytePart[] = [];
    let i = 0;
    for (const part of unnumbered) {
      while (i < numbered.length && byStart(numbered[i], part) < 0) ordered.push(numbered[i++]);
      ordered.push(part);
    }
    while (i < numbered.length) ordered.push(numbered[i++]);
    return ordered;
  }

  snapshot(): LivePreviewSnapshot {
    const thinkingChunks: string[] = [];
    const bodyChunks: string[] = [];
    const tools: LiveToolPreview[] = [];
    const activity: LiveActivityEntry[] = [];

    for (const part of this.orderedParts()) {
      if (part.kind === 'thinking') {
        if (part.text.length > 0) {
          thinkingChunks.push(part.text);
          if (part.text.trim()) activity.push({ kind: 'thinking', key: part.key, text: part.text });
        }
      } else if (part.kind === 'body') {
        if (part.text.length > 0) bodyChunks.push(part.text);
      } else if (part.kind === 'tool_input' && part.toolUseId && part.toolName) {
        const tool = {
          toolUseId: part.toolUseId,
          name: part.toolName,
          inputPreview: part.text.slice(-160),
        };
        tools.push(tool);
        activity.push({ kind: 'tool', key: part.key, tool });
      }
    }

    const body = bodyChunks.length > 0 ? bodyChunks.join('\n\n') : this.deltaFallback;
    return {
      runId: this.runId,
      thinking: thinkingChunks.join('\n\n'),
      body,
      tools,
      activity,
      awaitingHistoryHandoff: this.awaitingHistoryHandoff,
    };
  }
}
