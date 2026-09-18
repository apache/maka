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
import type { VoiceInterruption, VoiceLogInput, WorkHubVoiceTranscriptInput } from '@maka/runtime-host/protocol';

type Turn = { id: string; role: 'user' | 'assistant'; text: string; final: boolean; start_ms?: number; end_ms?: number };

/** A native turn has one record. Delta/final never become two conversational facts. */
export class WorkHubVoiceFacts {
  private readonly turns = new Map<string, Turn>();
  private readonly interruptions = new Map<string, VoiceInterruption>();
  private latestAssistant?: string;
  private readonly eventIds = new Set<string>();
  constructor(private readonly callId: string, private readonly emit: (event:
    | { kind: 'log'; entry: VoiceLogInput }
    | { kind: 'transcript'; item: WorkHubVoiceTranscriptInput }
    | { kind: 'interruption'; item: VoiceInterruption }) => void) {}

  accept(event: Record<string, unknown>, outputActive: boolean): void {
    if (typeof event.event_id === 'string') {
      if (this.eventIds.has(event.event_id)) return;
      this.eventIds.add(event.event_id);
    }
    const native = event.turn as Record<string, unknown> | undefined;
    const id = typeof native?.id === 'string' ? native.id : typeof event.turn_id === 'string' ? event.turn_id : undefined;
    if (!id) return;
    const role = native?.role;
    if (event.type === 'turn.created' && role === 'user' && outputActive && this.latestAssistant) {
      const assistant = this.turns.get(this.latestAssistant);
      if (assistant && !this.interruptions.has(id)) {
        const interruption = { userTurnId: id, user: '', assistant: this.output(assistant) };
        this.interruptions.set(id, interruption);
        this.emit({ kind: 'interruption', item: structuredClone(interruption) });
      }
    }
    let turn = this.turns.get(id);
    if (!turn && (role === 'user' || role === 'assistant')) {
      turn = { id, role, text: '', final: false };
      this.turns.set(id, turn);
    }
    if (!turn || turn.final) return;
    const interval = native ?? event;
    if (typeof interval.start_ms === 'number') turn.start_ms ??= interval.start_ms;
    if (typeof interval.end_ms === 'number') turn.end_ms = interval.end_ms;
    if (event.type === 'turn.delta' && typeof event.delta === 'string') {
      turn.text += event.delta;
      this.emit({ kind: 'log', entry: {
        id: createHash('sha256').update(JSON.stringify([this.callId,id,turn.text])).digest('hex'),
        kind: 'transcript_delta', data: { nativeTurnId: id, role: turn.role, delta: event.delta, start_ms: turn.start_ms, end_ms: turn.end_ms },
      } });
    }
    if (typeof native?.transcript === 'string') turn.text = native.transcript;
    if (turn.role === 'assistant' && (event.type === 'turn.created' || !this.latestAssistant)) this.latestAssistant = id;
    if (event.type !== 'turn.done') return;
    turn.final = true;
    if (turn.text.trim()) this.emit({ kind: 'transcript', item: {
      id: createHash('sha256').update(`voice:${this.callId}:${id}`).digest('hex'),
      callId: this.callId, nativeTurnId: id, role: turn.role, text: turn.text,
      ...(turn.start_ms === undefined ? {} : { start_ms: turn.start_ms }),
      ...(turn.end_ms === undefined ? {} : { end_ms: turn.end_ms }),
    } });
    if (turn.role === 'assistant') {
      for (const interruption of this.interruptions.values()) {
        if (interruption.assistant.id !== id) continue;
        interruption.assistant = this.output(turn);
        if (interruption.user) this.emit({ kind: 'interruption', item: structuredClone(interruption) });
      }
    } else {
      const interruption = this.interruptions.get(id);
      if (interruption && turn.text.trim()) {
        interruption.user = turn.text;
        this.emit({ kind: 'interruption', item: structuredClone(interruption) });
      }
    }
  }
  private output(turn: Turn): VoiceInterruption['assistant'] {
    return { id: turn.id, text: turn.text,
      ...(turn.start_ms === undefined ? {} : { start_ms: turn.start_ms }),
      ...(turn.end_ms === undefined ? {} : { end_ms: turn.end_ms }) };
  }
}
