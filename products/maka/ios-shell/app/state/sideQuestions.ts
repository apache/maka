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

import { trimHostWhitespace } from '../hostText';
import { effect, signal, untracked } from 'nsh';
import {
  hostMutate,
  hostQuery,
  type AgentFork,
  type AgentForkResult,
  type AgentObservation,
  type AgentSession,
} from '../bridge';
import { tr } from '../locale';
import { compareHistoryRows, type DraftQuote, type SideAnchor } from './chat';
import { activeHostInfo } from './hostPool';
import type { ScopedSession, watchSideQuestions } from './sessions';

export type SideDraftSource = { kind: 'row'; anchor: SideAnchor } | { kind: 'tray' };

export interface SideDraftRequest {
  main: ScopedSession;
  generation: number;
  source: SideDraftSource;
  quotes: readonly DraftQuote[];
  catalog: ReturnType<typeof watchSideQuestions>;
  pendingModel: () => Promise<boolean> | undefined;
}

export function sideDraftAnchor(source: SideDraftSource, quotes: readonly DraftQuote[]) {
  if (source.kind === 'row') return source.anchor;
  let latest: SideAnchor | undefined;
  for (const { anchor } of quotes) {
    if (!anchor) return;
    if (!latest || compareHistoryRows(anchor, latest) > 0) latest = anchor;
  }
  return latest;
}

export function createSideDraft(
  request: SideDraftRequest,
  active: () => boolean,
  onConnectionChanged: () => void,
  onForked: (
    session: AgentSession,
    question: string,
    quotes: readonly DraftQuote[],
    observed: AgentObservation,
  ) => void,
) {
  const {
    rootId,
    session: { id: sessionId },
  } = request.main;
  const { generation } = request;
  const text = signal('');
  const quotes = signal(request.quotes);
  const phase = signal<'idle' | 'checking' | 'forking' | 'uncertain'>('idle');
  const uncertain = () => phase() === 'uncertain';
  const busy = () => phase() === 'checking' || phase() === 'forking';
  const error = signal<string | null>(null);
  const sameConnection = () => activeHostInfo(rootId)?.generation === generation;
  const current = () => sameConnection() && active();
  const canSend = () =>
    sameConnection() &&
    phase() === 'idle' &&
    !!trimHostWhitespace(text()) &&
    !!sideDraftAnchor(request.source, quotes());

  effect(() => {
    if (!sameConnection()) untracked(onConnectionChanged);
  });

  const submit = async () => {
    if (!active() || !canSend()) return;
    const question = trimHostWhitespace(text());
    const firstQuotes = quotes();
    const anchor = sideDraftAnchor(request.source, firstQuotes);
    if (!anchor) return;
    phase.set('checking');
    error.set(null);
    let observed: AgentObservation;
    let result: AgentForkResult;
    try {
      const pending = request.pendingModel();
      if (pending && !(await pending)) throw new Error('Model selection was not committed');
      if (!current()) return;
      observed = await hostQuery<AgentObservation>(
        'agent',
        'observe',
        { sessionId },
        undefined,
        rootId,
      );
      if (!current()) return;
      if (
        observed.session.id !== sessionId ||
        observed.session.kind !== 'agent' ||
        observed.session.branch?.side
      )
        throw new Error('Conversation is not a side-question source');
      const line = [...question.replace(/\p{White_Space}+/gu, ' ')];
      const input: AgentFork = {
        sessionId,
        expectedRevision: observed.session.revision,
        position: { kind: 'through_source_turn', position: anchor.position },
        title: line.length > 60 ? line.slice(0, 59).join('') + '…' : line.join(''),
        labels: [],
        side: true,
      };
      phase.set('forking');
      result = await hostMutate<AgentForkResult>(
        'agent',
        'fork',
        { ...input },
        { rootId, generation },
      );
    } catch (cause) {
      console.warn('Could not open side question', cause);
      if (!current()) return;
      const uncertain = phase() === 'forking';
      phase.set(uncertain ? 'uncertain' : 'idle');
      error.set(
        uncertain
          ? tr('Side question creation could not be confirmed.')
          : tr('Could not create the side question. Try again.'),
      );
      return;
    }
    if (result.kind === 'forked') {
      // A fork receipt owns a real draft, even after the original route is gone.
      onForked(result.session, question, firstQuotes, observed);
    } else if (current()) {
      console.warn('Host declined fork', result.kind === 'rejected' ? result.reason : result.kind);
      phase.set('idle');
      error.set(tr('Could not create the side question. Try again.'));
    }
  };

  return { text, quotes, busy, uncertain, error, canSend, submit };
}
