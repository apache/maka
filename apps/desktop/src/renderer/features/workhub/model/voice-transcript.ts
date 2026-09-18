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

export interface VoiceTranscript { input: string; output: string }

/** Incremental display; completed native turns are persisted separately as voice context. */
export class VoiceTranscriptCollector {
  private seen = new Set<string>();
  private native = false;
  private turns: { input?: string; output?: string } = {};
  private value: VoiceTranscript = { input: '', output: '' };

  accept(event: Record<string, unknown>): VoiceTranscript | undefined {
    const type = event.type;
    if (type === 'turn.created' || type === 'turn.done') {
      const turn = event.turn as { id?: string; role?: string; transcript?: string } | undefined;
      if (turn?.role !== 'user' && turn?.role !== 'assistant') return;
      if (typeof turn.id !== 'string' || typeof turn.transcript !== 'string') return;
      const speaker = turn.role === 'user' ? 'input' : 'output';
      if (type === 'turn.done' && this.turns[speaker] !== turn.id) return;
      if (type === 'turn.created' && this.turns[speaker] === turn.id) return;
      this.native = true;
      this.turns[speaker] = turn.id;
      return this.update(speaker, turn.transcript);
    }
    if (type === 'turn.delta') {
      if (!this.native || typeof event.turn_id !== 'string') return;
      const speaker = event.turn_id === this.turns.input ? 'input'
        : event.turn_id === this.turns.output ? 'output' : undefined;
      if (!speaker || typeof event.delta !== 'string') return;
      return this.update(speaker, this.value[speaker] + event.delta);
    }

    let speaker: 'input' | 'output';
    let text: unknown;
    let key: unknown;
    let replace = false;
    if (type === 'input_transcript.added' || type === 'output_transcript.added') {
      if (this.native) return; // The same fragments also arrive in their native turn.
      const item = event.item as Record<string, unknown> | undefined;
      speaker = type === 'input_transcript.added' ? 'input' : 'output';
      text = item?.text; key = item?.id;
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      speaker = 'input'; text = event.transcript; key = event.item_id; replace = true;
    } else if (type === 'response.audio_transcript.delta' || type === 'response.output_audio_transcript.delta') {
      speaker = 'output'; text = event.delta; key = event.event_id;
    } else return;
    if (typeof text !== 'string' || !text) return;
    if (typeof key === 'string') {
      const id = `${speaker}:${key}`;
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    }
    return this.update(speaker, (replace ? '' : this.value[speaker]) + text);
  }

  private update(speaker: 'input' | 'output', text: string): VoiceTranscript | undefined {
    const value = text.slice(-4000);
    if (value === this.value[speaker]) return;
    this.value = { ...this.value, [speaker]: value };
    return this.value;
  }
}
