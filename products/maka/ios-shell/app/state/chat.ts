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

import { approvalOutcome } from '../approval';
import type {
  AgentInteractionResult,
  AgentSendResult,
} from '../../../../../packages/plugin-sdk/src/generated/runtime';
import { cleanup, effect, signal } from 'nsh';
import {
  hostMutate,
  hostQuery,
  onSubscriptionEnded,
  onSubscriptionItem,
  subscribe,
  unsubscribe,
  type AgentBackendPreference,
  type AgentDeliveryPage,
  type AgentGitWorkspaceDiff,
  type AgentHistoryChunk,
  type AgentHistoryPage,
  type AgentInteractionRecord,
  type AgentInteractionSummary,
  type AgentModelChoice,
  type AgentObservation,
  type AgentQueue,
  type AgentRoomMessage,
  type AgentSession,
  type SubscriptionHandle,
} from '../bridge';
import { LivePreviewAccumulator, type LivePreviewSnapshot } from '../streaming';
import { activeHostInfo, hostById, showToast } from './hostPool';
import { refreshHostInbox } from './inbox';
import { hapticNotification, hapticSelection } from './preferences';
import { refreshHostSessions } from './sessions';
import { modelBackend, readDefaultModel } from './settings/models';
import { settingsRpc } from './settings/rpc';
import { tr } from '../locale';

export function compareHistoryRows(a: AgentHistoryChunk, b: AgentHistoryChunk): number {
  for (let i = 0; i < Math.min(a.order.path.length, b.order.path.length); i++) {
    const order = a.order.path[i] - b.order.path[i];
    if (order) return order;
  }
  return a.order.path.length - b.order.path.length || a.order.itemIndex - b.order.itemIndex;
}

export function conversationKey(rootId: string, sessionId: string): string {
  return rootId + '::' + sessionId;
}

const draftMap = signal<Record<string, { text: string }>>({});
const scrollOffsetMap = new Map<string, number>();

export function getDraft(rootId: string, sessionId: string): string {
  return draftMap()[conversationKey(rootId, sessionId)]?.text ?? '';
}

export function setDraft(rootId: string, sessionId: string, value: string) {
  const key = conversationKey(rootId, sessionId);
  draftMap.update((prev) =>
    (prev[key]?.text ?? '') === value ? prev : { ...prev, [key]: { text: value } },
  );
}

export function appendQuoteToDraft(
  rootId: string,
  sessionId: string,
  filePath: string,
  lineNumber: number,
  snippet?: string,
) {
  const tick = String.fromCharCode(96);
  const quoteHeader = '> ' + tick + filePath + ':' + String(lineNumber) + tick;
  const quoteLine = snippet?.trim() ? quoteHeader + '\n> ' + snippet.trim() : quoteHeader;
  const current = getDraft(rootId, sessionId);
  const next =
    current.trim().length > 0 ? current.trimEnd() + '\n\n' + quoteLine + '\n' : quoteLine + '\n';
  setDraft(rootId, sessionId, next);
}

export function getSavedScrollOffset(rootId: string, sessionId: string): number {
  return scrollOffsetMap.get(conversationKey(rootId, sessionId)) ?? 0;
}

export function saveScrollOffset(rootId: string, sessionId: string, y: number) {
  scrollOffsetMap.set(conversationKey(rootId, sessionId), Math.max(0, y));
}

export interface ParsedDiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  deleted: number;
  patch: string;
}

export function parseUnifiedDiffFiles(fullPatch: string): ParsedDiffFile[] {
  if (!fullPatch.trim()) return [];
  const sections = fullPatch.split(/(?=^diff --git )/m).filter((s) => s.trim().length > 0);
  const files: ParsedDiffFile[] = [];
  for (const section of sections) {
    const lines = section.split('\n');
    const header = lines[0] ?? '';
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
    let path = match ? match[2] : '';
    let oldPath = match && match[1] !== match[2] ? match[1] : undefined;
    let status: ParsedDiffFile['status'] = oldPath ? 'renamed' : 'modified';
    let added = 0;
    let deleted = 0;
    for (const line of lines) {
      if (line.startsWith('new file mode')) status = 'added';
      else if (line.startsWith('deleted file mode')) status = 'deleted';
      else if (line.startsWith('rename to ')) {
        status = 'renamed';
        path = line.slice('rename to '.length).trim();
      } else if (line.startsWith('rename from ')) {
        oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('+++ b/') && !path) {
        path = line.slice('+++ b/'.length).trim();
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        added += 1;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deleted += 1;
      }
    }
    if (!path) path = 'changes.diff';
    files.push({ path, oldPath, status, added, deleted, patch: section });
  }
  return files;
}

export function extractPatchLineText(
  patch: string,
  side: 'old' | 'new',
  targetLine: number,
): string {
  const lines = patch.split('\n');
  let oldCur = 0;
  let newCur = 0;
  let inHunk = false;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldCur = Number(hunk[1]);
      newCur = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      if (side === 'new' && newCur === targetLine) return line.slice(1);
      newCur += 1;
    } else if (line.startsWith('-')) {
      if (side === 'old' && oldCur === targetLine) return line.slice(1);
      oldCur += 1;
    } else if (!line.startsWith('\\')) {
      if ((side === 'new' && newCur === targetLine) || (side === 'old' && oldCur === targetLine)) {
        return line.startsWith(' ') ? line.slice(1) : line;
      }
      oldCur += 1;
      newCur += 1;
    }
  }
  return '';
}

export async function fetchGitWorkspaceDiff(
  rootId: string,
  sessionId: string,
): Promise<AgentGitWorkspaceDiff | null> {
  return hostQuery<AgentGitWorkspaceDiff | null>(
    'agent',
    'gitWorkspaceDiff',
    { sessionId, area: null, worktreePath: null },
    undefined,
    rootId,
  );
}

let watchSeq = 0;

export function createConversationController(rootId: string, initialSession: AgentSession) {
  const sessionId = initialSession.id;
  const observed = signal<{ generation: number; value: AgentObservation } | null>(null);
  const observation = () => {
    const snapshot = observed();
    return snapshot && snapshot.generation === activeHostInfo(rootId)?.generation
      ? snapshot.value
      : null;
  };
  const selectedBackend = () => {
    const current = observation();
    return current?.session.backend ?? current?.rememberedBackend ?? null;
  };
  const chunks = signal<AgentHistoryChunk[]>([]);
  const roomMessages = signal<AgentRoomMessage[]>([]);
  const isRoom = signal(initialSession.kind === 'room');
  const beforeCursor = signal<unknown>(null);
  const loading = signal(true);
  const earlierGeneration = signal<number | null>(null);
  const loadingEarlier = () =>
    earlierGeneration() !== null && earlierGeneration() === activeHostInfo(rootId)?.generation;
  const sending = signal(false);
  const modelSelection = signal<{ generation: number; done: Promise<boolean> } | null>(null);
  const selectingModel = () => {
    const pending = modelSelection();
    return pending?.generation === activeHostInfo(rootId)?.generation ? pending : null;
  };
  const error = signal<string | null>(null);
  const queue = signal<AgentQueue>({ revision: 0, entries: [] });
  const pendingInteractions = signal<AgentInteractionRecord[]>([]);
  const models = signal<AgentModelChoice[]>([]);
  const busyInteractionIds = signal<Record<string, boolean>>({});

  const accumulator = new LivePreviewAccumulator();
  const livePreview = signal<LivePreviewSnapshot>(accumulator.snapshot());

  let disposed = false;
  let lastThrough: number | null = null;
  let watchHandle: SubscriptionHandle | null = null;
  let watchSubId: string | null = null;
  let activeGeneration = -1;

  const stopWatch = () => {
    watchSubId = null;
    if (watchHandle) {
      const h = watchHandle;
      watchHandle = null;
      void unsubscribe(h).catch(() => {});
    }
  };

  const loadInteractions = async () => {
    try {
      const res = await hostQuery<{
        revision: number;
        entries: AgentInteractionSummary[];
      }>('agent', 'pendingInteractions', { sessionId }, undefined, rootId);
      if (disposed) return;
      const records: AgentInteractionRecord[] = [];
      for (const entry of res?.entries ?? []) {
        const rec = await hostQuery<AgentInteractionRecord | null>(
          'agent',
          'interaction',
          { sessionId, requestId: entry.requestId },
          undefined,
          rootId,
        ).catch(() => null);
        if (disposed) return;
        if (rec && (rec.outcome === null || rec.outcome === undefined)) {
          records.push(rec);
        }
      }
      if (!disposed) pendingInteractions.set(records);
    } catch {
      // Preserve last known interactions on transient query errors.
    }
  };

  const joinHistory = (older: AgentHistoryChunk[], tail: AgentHistoryChunk[]) => {
    const first = tail[0];
    if (!first) return older;
    const prefix: AgentHistoryChunk[] = [];
    for (const row of older) {
      const order = compareHistoryRows(row, first);
      if (order > 0 || (order === 0 && row.offset >= first.offset)) break;
      if (order < 0) {
        prefix.push(row);
        continue;
      }
      // Host offsets are UTF-8 byte offsets on character boundaries.
      let remaining = first.offset - row.offset;
      let end = 0;
      for (const character of row.text) {
        if (remaining <= 0) break;
        const code = character.codePointAt(0)!;
        remaining -= code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        end += character.length;
      }
      prefix.push(end === row.text.length ? row : { ...row, text: row.text.slice(0, end) });
    }
    return [...prefix, ...tail];
  };
  let pagedHistory = false;
  const refreshTail = async () => {
    const generation = activeHostInfo(rootId)?.generation;
    try {
      const page = await hostQuery<AgentHistoryPage>(
        'agent',
        'history',
        {
          sessionId,
          through: null,
          position: { kind: 'tail' },
          includeThinking: true,
          view: 'conversation',
        },
        undefined,
        rootId,
      );
      if (disposed || activeHostInfo(rootId)?.generation !== generation) return;
      const preserveHistory = pagedHistory || loadingEarlier();
      if (page?.kind === 'room') {
        isRoom.set(true);
        const tail = page.page.items;
        if (tail.length || !preserveHistory)
          roomMessages.update((previous) =>
            preserveHistory && tail.length
              ? [...previous.filter((item) => item.sequence < tail[0].sequence), ...tail]
              : tail,
          );
        if (!preserveHistory) beforeCursor.set(page.page.before ?? null);
        if (typeof page.page?.through === 'number') {
          lastThrough = Math.max(lastThrough ?? 0, page.page.through);
        }
      } else if (page?.kind === 'ready') {
        isRoom.set(false);
        const tail = page.chunks;
        if (tail.length || !preserveHistory)
          chunks.update((previous) =>
            preserveHistory && tail.length ? joinHistory(previous, tail) : tail,
          );
        if (!preserveHistory) beforeCursor.set(page.before ?? null);
        if (typeof page.through === 'number') {
          lastThrough = Math.max(lastThrough ?? 0, page.through);
        }
      }
      const handoff = !historyDirty && accumulator.completeHandoffIfPending();
      if (handoff) livePreview.set(handoff);
    } catch (cause) {
      if (!disposed && activeHostInfo(rootId)?.generation === generation) {
        error.set(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };

  let historyDirty = false;
  let historyFlight: Promise<void> | undefined;
  const loadHistory = () => {
    if (disposed) return Promise.resolve();
    historyDirty = true;
    historyFlight ??= (async () => {
      try {
        while (historyDirty && !disposed) {
          historyDirty = false;
          await refreshTail();
        }
      } finally {
        historyFlight = undefined;
      }
    })();
    return historyFlight;
  };

  const loadModels = async () => {
    try {
      const page = await hostQuery<{ kind: string; choices?: AgentModelChoice[] }>(
        'agent',
        'models',
        { kind: 'start', query: '' },
        undefined,
        rootId,
      );
      if (!disposed && page?.kind === 'ready' && Array.isArray(page.choices)) {
        models.set(page.choices);
      }
    } catch {
      // Models list is optional when offline or unsupported.
    }
  };

  let observeFlight: { generation: number; promise: Promise<void> } | undefined;
  const loadObserve = () => {
    const generation = activeHostInfo(rootId)?.generation;
    if (generation === undefined) return;
    if (observeFlight?.generation === generation) return observeFlight.promise;
    const promise = (async () => {
      try {
        const obs = await hostQuery<AgentObservation>(
          'agent',
          'observe',
          { sessionId },
          undefined,
          rootId,
        );
        if (disposed || activeHostInfo(rootId)?.generation !== generation) return;
        const current = observation();
        if (current && obs.session.revision < current.session.revision) return;
        observed.set({ generation, value: obs });
        if (obs.session?.kind === 'room') isRoom.set(true);
        if (typeof obs.through === 'number') {
          lastThrough = Math.max(lastThrough ?? 0, obs.through);
        }
      } catch (cause) {
        if (!disposed && activeHostInfo(rootId)?.generation === generation) {
          error.set(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (observeFlight?.generation === generation) observeFlight = undefined;
      }
    })();
    observeFlight = { generation, promise };
    return promise;
  };

  const startWatch = (gen: number) => {
    stopWatch();
    const subId = 'watch:' + rootId + ':' + sessionId + ':' + String(++watchSeq);
    watchSubId = subId;
    void subscribe(subId, 'agent', 'watch', { sessionId, after: lastThrough ?? 0 }, rootId)
      .then((handle) => {
        if (disposed || watchSubId !== subId) {
          void unsubscribe(handle).catch(() => {});
          return;
        }
        watchHandle = handle;
        activeGeneration = gen;
      })
      .catch(() => {});
  };

  const refreshAll = async () => {
    error.set(null);
    loading.set(true);
    try {
      await Promise.all([loadObserve(), loadHistory(), loadInteractions(), loadModels()]);
    } finally {
      if (!disposed) loading.set(false);
    }
  };

  const loadEarlier = async () => {
    const cursor = beforeCursor();
    const generation = activeHostInfo(rootId)?.generation;
    if (cursor == null || generation == null || loadingEarlier()) return;
    earlierGeneration.set(generation);
    try {
      const page = await hostQuery<AgentHistoryPage>(
        'agent',
        'history',
        {
          sessionId,
          through: lastThrough,
          position: isRoom()
            ? { kind: 'before_message', messageId: cursor }
            : { kind: 'before', cursor },
          includeThinking: true,
          view: 'conversation',
        },
        undefined,
        rootId,
      );
      if (disposed || activeHostInfo(rootId)?.generation !== generation) return;
      pagedHistory = true;
      if (page?.kind === 'room') {
        const older = page.page?.items ?? [];
        const existing = roomMessages();
        const seen = new Set(existing.map((m) => m.id));
        roomMessages.set([...older.filter((m) => !seen.has(m.id)), ...existing]);
        beforeCursor.set(page.page?.before ?? null);
      } else if (page?.kind === 'ready') {
        const older = page.chunks ?? [];
        chunks.update((existing) => joinHistory(older, existing));
        beforeCursor.set(page.before ?? null);
      }
    } catch (cause) {
      if (!disposed && activeHostInfo(rootId)?.generation === generation) {
        showToast(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!disposed && earlierGeneration() === generation) earlierGeneration.set(null);
    }
  };

  // Always uses 'queue' delivery (never implicit steer-while-running).
  const sendMessage = async () => {
    const key = conversationKey(rootId, sessionId);
    const draft = draftMap()[key];
    const text = draft?.text.trim();
    if (!text || sending()) return false;
    sending.set(true);
    error.set(null);
    try {
      const connection = activeHostInfo(rootId);
      if (!connection) throw new Error(tr('Computer is offline'));
      const { generation } = connection;
      let backend: AgentBackendPreference | null = null;
      if (!isRoom()) {
        const pending = selectingModel();
        if (pending && !(await pending.done)) return false;
        if (!observation() && activeHostInfo(rootId)?.generation === generation)
          await loadObserve();
        if (disposed) return false;
        if (activeHostInfo(rootId)?.generation !== generation)
          throw new Error(tr('Computer is offline'));
        if (!observation()) throw new Error(error() ?? tr('Select model'));
        backend = selectedBackend();
        if (!backend && connection.endpoints.includes('settings')) {
          const choice = await readDefaultModel(settingsRpc(rootId));
          backend = selectedBackend() ?? (choice ? modelBackend(choice) : null);
        }
        if (!backend) throw new Error(tr('Select model'));
      }
      if (disposed) return false;
      const res = await hostMutate<AgentSendResult>(
        'agent',
        'send',
        {
          mentions: [],
          replyTo: null,
          onComplete: null,
          quotes: [],
          delivery: 'queue',
          expectedRunId: null,
          attachments: [],
          backend,
          sessionId,
          message: text,
        },
        { rootId, generation },
      );
      if (res.kind !== 'started' && res.kind !== 'queued' && res.kind !== 'posted') {
        throw new Error(res.kind === 'rejected' ? res.reason : res.kind);
      }
      if (draftMap()[key] === draft) setDraft(rootId, sessionId, '');
      hapticSelection();
      await Promise.all([loadObserve(), loadHistory()]);
      const hostName = hostById(rootId)?.hostName ?? rootId;
      void refreshHostSessions(rootId, hostName);
      return true;
    } catch (cause) {
      hapticNotification('error');
      const msg = cause instanceof Error ? cause.message : String(cause);
      error.set(msg);
      showToast(msg);
      return false;
    } finally {
      if (!disposed) sending.set(false);
    }
  };

  const stopRun = async () => {
    const run = observation()?.run;
    if (!run) return;
    try {
      await hostMutate('agent', 'stop', { sessionId, runId: run.runId }, { rootId });
      hapticNotification('warning');
      await loadObserve();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectModel = (backend: AgentBackendPreference) => {
    const generation = activeHostInfo(rootId)?.generation;
    if (disposed || isRoom() || generation === undefined || selectingModel() || sending()) return;
    const done = (async () => {
      try {
        if (!observation()) await loadObserve();
        if (disposed || activeHostInfo(rootId)?.generation !== generation) return false;
        if (!observation()) throw new Error(error() ?? tr('Select model'));
        const result = await hostMutate<
          import('../../../../../packages/plugin-sdk/src/generated/runtime').AgentMetadataResult
        >('agent', 'selectBackend', { sessionId, backend }, { rootId, generation });
        if (disposed || activeHostInfo(rootId)?.generation !== generation) return false;
        if (result.kind !== 'committed') throw new Error(result.kind);
        const current = observation()!;
        if (result.session.revision >= current.session.revision) {
          observed.set({ generation, value: { ...current, session: result.session } });
        }
        hapticSelection();
        return true;
      } catch (cause) {
        if (!disposed && activeHostInfo(rootId)?.generation === generation) {
          showToast(cause instanceof Error ? cause.message : String(cause));
        }
        return false;
      } finally {
        if (modelSelection()?.generation === generation) modelSelection.set(null);
      }
    })();
    modelSelection.set({ generation, done });
    return done;
  };

  const cancelQueuedMessage = async (messageId: string) => {
    const q = queue();
    try {
      const result = await hostMutate<
        import('../../../../../packages/plugin-sdk/src/generated/runtime').AgentQueueMutationResult
      >(
        'agent',
        'editQueue',
        {
          sessionId,
          expectedRevision: q.revision,
          edit: { kind: 'retract', messageId },
        },
        { rootId },
      );
      queue.set(await hostQuery<AgentQueue>('agent', 'queue', { sessionId }, undefined, rootId));
      if (result.kind !== 'committed')
        throw new Error(result.kind === 'rejected' ? result.reason : result.kind);
      hapticSelection();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const respondInteraction = async (requestId: string, answer: Record<string, unknown>) => {
    if (busyInteractionIds()[requestId]) return null;
    busyInteractionIds.update((prev) => ({ ...prev, [requestId]: true }));
    try {
      const result = await hostMutate<AgentInteractionResult>(
        'agent',
        'respond',
        { sessionId, requestId, answer },
        { rootId },
      );
      if (result.kind === 'rejected') {
        void loadInteractions();
        throw new Error(result.reason);
      }
      hapticNotification(approvalOutcome(result.record.outcome) === false ? 'warning' : 'success');
      const hostName = hostById(rootId)?.hostName ?? rootId;
      await Promise.all([
        loadInteractions(),
        loadObserve(),
        refreshHostInbox(rootId, hostName),
        refreshHostSessions(rootId, hostName),
      ]);
      return result.record;
    } catch (cause) {
      hapticNotification('error');
      showToast(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      if (!disposed) {
        busyInteractionIds.update((prev) => {
          const next = { ...prev };
          delete next[requestId];
          return next;
        });
      }
    }
  };

  const offItem = onSubscriptionItem((payload) => {
    if (disposed || !watchSubId || payload.subscriptionId !== watchSubId) return;
    if (payload.rootId && payload.rootId !== rootId) return;
    const page = payload.item as AgentDeliveryPage | undefined;
    if (!page || typeof page !== 'object') return;

    if (page.kind === 'preview') {
      livePreview.set(accumulator.applyPreviewPage(page.page));
      return;
    }
    if (page.kind === 'queue') {
      queue.set(page.queue);
      return;
    }
    if (page.kind === 'interactions') {
      void loadInteractions();
      const hostName = hostById(rootId)?.hostName ?? rootId;
      void refreshHostInbox(rootId, hostName);
      return;
    }
    if (page.kind === 'room') {
      if (typeof page.through === 'number') lastThrough = Math.max(lastThrough ?? 0, page.through);
      void loadHistory();
      return;
    }
    if (page.kind === 'events') {
      if (typeof page.through === 'number') lastThrough = Math.max(lastThrough ?? 0, page.through);
      let needsHistory = false;
      let needsObserve = false;
      for (const ev of page.events ?? []) {
        const fact = ev.fact;
        if (fact.kind === 'delta') {
          livePreview.set(accumulator.applyDelta(ev.runId, fact.text));
        } else if (
          fact.kind === 'part_committed' ||
          fact.kind === 'transcript_changed' ||
          fact.kind === 'tool_settled' ||
          fact.kind === 'executor_tool_result' ||
          [
            'step_ended',
            'executor_text_changed',
            'executor_tool_start',
            'tool_dispatched',
          ].includes(fact.kind)
        ) {
          needsHistory = true;
        } else if (['opened', 'executor_started'].includes(fact.kind)) {
          needsObserve = true;
        } else if (fact.kind === 'ended') {
          needsHistory = true;
          needsObserve = true;
          livePreview.set(accumulator.beginHandoff());
        }
      }
      if (needsHistory) void loadHistory();
      if (needsObserve) {
        void loadObserve();
        const hostName = hostById(rootId)?.hostName ?? rootId;
        void refreshHostSessions(rootId, hostName);
      }
    }
  });

  const offEnded = onSubscriptionEnded((payload) => {
    if (disposed || !watchSubId || payload.subscriptionId !== watchSubId) return;
    watchHandle = null;
    watchSubId = null;
  });

  effect(() => {
    const conn = activeHostInfo(rootId);
    if (!conn) {
      stopWatch();
      activeGeneration = -1;
      return;
    }
    const gen = conn.generation ?? 0;
    if (gen === activeGeneration) return;
    activeGeneration = gen;
    void refreshAll().then(() => {
      if (!disposed && activeHostInfo(rootId)?.generation === gen) {
        startWatch(gen);
      }
    });
  });

  cleanup(() => {
    disposed = true;
    offItem();
    offEnded();
    stopWatch();
  });

  return {
    observation,
    selectedBackend,
    selectingModel,
    chunks,
    roomMessages,
    isRoom,
    beforeCursor,
    loading,
    loadingEarlier,
    sending,
    error,
    queue,
    pendingInteractions,
    models,
    busyInteractionIds,
    livePreview,
    refreshAll,
    loadEarlier,
    sendMessage,
    stopRun,
    selectModel,
    cancelQueuedMessage,
    respondInteraction,
  };
}
