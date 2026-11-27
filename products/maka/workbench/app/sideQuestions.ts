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

import type { AgentSession, HistoryRowAddress } from '../../../../packages/plugin-sdk/src/index.js';
import { signal } from 'nsh';
import { sameHistoryRow, type Row } from './history';
import { tr } from './locale';

/** A side question to underline in the reply it was asked beside. */
export type SideMark = {
  id: string;
  title: string;
  /** The passages it quotes, as they were selected. */
  quotes: readonly string[];
  /** Its card is open. */
  open: boolean;
};

/** A follow-up a side question's answer can be given in one press. */
export type SideFollowUp = { emoji: string; label: string; message: string };

/** The ready follow-ups, in the interface's language: the model reads `message`. */
export const sideFollowUps = (): SideFollowUp[] => [
  { emoji: '🤔', label: tr('Simpler'), message: tr('Explain that more simply.') },
  { emoji: '🔍', label: tr('Go deeper'), message: tr('Go deeper on that.') },
  { emoji: '✂️', label: tr('Shorter'), message: tr('Say that in fewer words.') },
  { emoji: '💡', label: tr('Example'), message: tr('Give me an example.') },
];

const TITLE_LENGTH = 60;

/** A side question is named by what it asks. */
export function sideTitle(question: string): string {
  const line = question.trim().replace(/\s+/g, ' ');
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

/** The row a side question was asked beside: the reply its branch runs through. */
export function sideAnchor(session: Pick<AgentSession, 'branch'>): HistoryRowAddress | null {
  const branch = session.branch;
  if (!branch?.side) return null;
  return branch.position.kind === 'through_source_turn' ? branch.position.position : null;
}

/** The side questions asked beside one reply, oldest first, of a list that has the latest first. */
export function sideQuestionsAt<T extends Pick<AgentSession, 'branch'>>(
  sessions: readonly T[],
  position: HistoryRowAddress,
): T[] {
  return sessions
    .filter((session) => {
      const anchor = sideAnchor(session);
      return anchor !== null && sameHistoryRow(anchor, position);
    })
    .reverse();
}

/** A passage of a reply, kept to ask about together with others. */
export type GatheredPassage = { position: HistoryRowAddress; turnId?: string; text: string };

const maxGathered = 8;
const gathered = signal<ReadonlyMap<string, readonly GatheredPassage[]>>(new Map());

export const gatheredPassages = (sessionId: string) => gathered().get(sessionId) ?? [];

function setGathered(sessionId: string, passages: readonly GatheredPassage[]) {
  const next = new Map(gathered());
  if (passages.length > 0) next.set(sessionId, passages);
  else next.delete(sessionId);
  gathered.set(next);
}

/** False when the passage is already gathered or eight are. */
export function gatherPassage(sessionId: string, passage: GatheredPassage) {
  const current = gatheredPassages(sessionId);
  if (
    current.length >= maxGathered ||
    current.some(
      (old) => sameHistoryRow(old.position, passage.position) && old.text === passage.text,
    )
  )
    return false;
  setGathered(sessionId, [...current, passage]);
  return true;
}

export const dropGathered = (sessionId: string, index: number) =>
  setGathered(
    sessionId,
    gatheredPassages(sessionId).filter((_, at) => at !== index),
  );

export const clearGathered = (sessionId: string) => setGathered(sessionId, []);
