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
      this.turns[speaker] = turn.id;
      return this.update(speaker, turn.transcript);
    }
    if (type === 'turn.delta') {
      if (typeof event.turn_id !== 'string') return;
      const speaker = event.turn_id === this.turns.input ? 'input'
        : event.turn_id === this.turns.output ? 'output' : undefined;
      if (!speaker || typeof event.delta !== 'string') return;
      return this.update(speaker, this.value[speaker] + event.delta);
    }

  }

  private update(speaker: 'input' | 'output', text: string): VoiceTranscript | undefined {
    const value = text.slice(-4000);
    if (value === this.value[speaker]) return;
    this.value = { ...this.value, [speaker]: value };
    return this.value;
  }
}
