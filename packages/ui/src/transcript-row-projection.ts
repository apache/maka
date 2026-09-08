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

export interface TranscriptTurnRow<Turn> {
  kind: 'turn';
  turn: Turn;
}

export interface TranscriptGapRow {
  kind: 'gap';
  direction: 'older' | 'newer';
}

export type TranscriptRow<Turn> = TranscriptTurnRow<Turn> | TranscriptGapRow;

export interface TranscriptRowProjectionInput<Turn> {
  turns: readonly Turn[];
  hasOlder: boolean;
  hasNewer: boolean;
  activeTurnId?: string;
}

export function projectTranscriptRows<Turn extends { turnId: string }>(
  input: TranscriptRowProjectionInput<Turn>,
): readonly TranscriptRow<Turn>[] {
  const rows: TranscriptRow<Turn>[] = input.turns.map((turn) => ({ kind: 'turn', turn }));

  if (input.hasNewer) {
    const activeTurnIndex = input.activeTurnId
      ? rows.findIndex((row) => row.kind === 'turn' && row.turn.turnId === input.activeTurnId)
      : -1;
    const gapIndex = activeTurnIndex >= 0 ? activeTurnIndex : rows.length;
    rows.splice(gapIndex, 0, { kind: 'gap', direction: 'newer' });
  }

  if (input.hasOlder) {
    rows.unshift({ kind: 'gap', direction: 'older' });
  }

  return rows;
}
