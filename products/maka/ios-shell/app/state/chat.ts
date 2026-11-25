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
  type SubscriptionHandle,
} from '../bridge';
import { LivePreviewAccumulator, type LivePreviewSnapshot } from '../streaming';
import { activeHostInfo, hostById, showToast } from './hostPool';
import { refreshHostInbox } from './inbox';
import { hapticNotification, hapticSelection } from './preferences';
import { refreshHostSessions } from './sessions';

export function conversationKey(rootId: string, sessionId: string): string {
  return rootId + '::' + sessionId;
}

const draftMap = signal<Record<string, string>>({});
const scrollOffsetMap = new Map<string, number>();
const backendMap = signal<Record<string, AgentBackendPreference | null>>({});

export function getDraft(rootId: string, sessionId: string): string {
  return draftMap()[conversationKey(rootId, sessionId)] ?? '';
}

export function setDraft(rootId: string, sessionId: string, value: string) {
  const key = conversationKey(rootId, sessionId);
  draftMap.update((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
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

export function getSelectedBackend(
  rootId: string,
  sessionId: string,
): AgentBackendPreference | null {
  return backendMap()[conversationKey(rootId, sessionId)] ?? null;
}

export function setSelectedBackend(
  rootId: string,
  sessionId: string,
  backend: AgentBackendPreference | null,
) {
  const key = conversationKey(rootId, sessionId);
  backendMap.update((prev) => ({ ...prev, [key]: backend }));
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

export function createConversationController(rootId: string, sessionId: string) {
  const observation = signal<AgentObservation | null>(null);
  const chunks = signal<AgentHistoryChunk[]>([]);
  const roomMessages = signal<AgentRoomMessage[]>([]);
  const isRoom = signal(false);
  const beforeCursor = signal<unknown>(null);
  const loading = signal(true);
  const loadingEarlier = signal(false);
  const sending = signal(false);
  const error = signal<string | null>(null);
  const queue = signal<AgentQueue>({ revision: 0, entries: [] });
  const pendingInteractions = signal<AgentInteractionRecord[]>([]);
  const models = signal<AgentModelChoice[]>([]);
  const busyInteractionIds = signal<Record<string, boolean>>({});

  const accumulator = new LivePreviewAccumulator();
  const livePreview = signal<LivePreviewSnapshot>(accumulator.snapshot());

  let disposed = false;
  let lastThrough = 0;
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

  const loadHistory = async () => {
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
      if (disposed) return;
      if (page?.kind === 'room') {
        isRoom.set(true);
        roomMessages.set(page.page?.items ?? []);
        beforeCursor.set(page.page?.before ?? null);
        if (typeof page.page?.through === 'number') {
          lastThrough = Math.max(lastThrough, page.page.through);
        }
      } else if (page?.kind === 'ready') {
        isRoom.set(false);
        chunks.set(page.chunks ?? []);
        beforeCursor.set(page.before ?? null);
        if (typeof page.through === 'number') {
          lastThrough = Math.max(lastThrough, page.through);
        }
      }
      const handoff = accumulator.completeHandoffIfPending();
      if (handoff) livePreview.set(handoff);
    } catch (cause) {
      if (!disposed) {
        error.set(cause instanceof Error ? cause.message : String(cause));
      }
    }
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

  const loadObserve = async () => {
    try {
      const obs = await hostQuery<AgentObservation>(
        'agent',
        'observe',
        { sessionId },
        undefined,
        rootId,
      );
      if (disposed) return;
      observation.set(obs);
      if (obs.session?.kind === 'room') isRoom.set(true);
      if (typeof obs.through === 'number') {
        lastThrough = Math.max(lastThrough, obs.through);
      }
      if (obs.session?.backend && !getSelectedBackend(rootId, sessionId)) {
        setSelectedBackend(rootId, sessionId, obs.session.backend);
      }
    } catch (cause) {
      if (!disposed) {
        error.set(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };

  const startWatch = (gen: number) => {
    stopWatch();
    const subId = 'watch:' + rootId + ':' + sessionId + ':' + String(++watchSeq);
    watchSubId = subId;
    void subscribe(subId, 'agent', 'watch', { sessionId, after: lastThrough }, rootId)
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
    if (!cursor || loadingEarlier()) return;
    loadingEarlier.set(true);
    try {
      const page = await hostQuery<AgentHistoryPage>(
        'agent',
        'history',
        {
          sessionId,
          through: lastThrough || null,
          position: { kind: 'before', cursor },
          includeThinking: true,
          view: 'conversation',
        },
        undefined,
        rootId,
      );
      if (disposed) return;
      if (page?.kind === 'room') {
        const older = page.page?.items ?? [];
        const existing = roomMessages();
        const seen = new Set(existing.map((m) => m.id));
        roomMessages.set([...older.filter((m) => !seen.has(m.id)), ...existing]);
        beforeCursor.set(page.page?.before ?? null);
      } else if (page?.kind === 'ready') {
        const older = page.chunks ?? [];
        chunks.update((existing) => [...older, ...existing]);
        beforeCursor.set(page.before ?? null);
      }
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed) loadingEarlier.set(false);
    }
  };

  // Always uses 'queue' delivery (never implicit steer-while-running).
  const sendMessage = async () => {
    const text = getDraft(rootId, sessionId).trim();
    if (!text || sending()) return false;
    sending.set(true);
    error.set(null);
    try {
      const backend = getSelectedBackend(rootId, sessionId);
      const res = await hostMutate<{ kind: string; reason?: unknown }>(
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
        { rootId },
      );
      if (res?.kind === 'rejected') {
        throw new Error(String(res.reason ?? 'rejected'));
      }
      setDraft(rootId, sessionId, '');
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

  const selectModel = async (backend: AgentBackendPreference) => {
    setSelectedBackend(rootId, sessionId, backend);
    hapticSelection();
    try {
      await hostMutate('agent', 'selectBackend', { sessionId, backend }, { rootId });
    } catch {
      // Local selection still applies on next send.
    }
  };

  const cancelQueuedMessage = async (messageId: string) => {
    const q = queue();
    const remaining = q.entries.filter((e) => e.messageId !== messageId).map((e) => e.messageId);
    try {
      await hostMutate(
        'agent',
        'editQueue',
        {
          sessionId,
          expectedRevision: q.revision,
          edit: { kind: 'reorder', messageIds: remaining },
        },
        { rootId },
      );
      queue.update((prev) => ({
        revision: prev.revision + 1,
        entries: prev.entries.filter((e) => e.messageId !== messageId),
      }));
      hapticSelection();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const respondInteraction = async (
    requestId: string,
    answer: Record<string, unknown>,
    kind: 'success' | 'warning' = 'success',
  ) => {
    busyInteractionIds.update((prev) => ({ ...prev, [requestId]: true }));
    try {
      await hostMutate('agent', 'respond', { sessionId, requestId, answer }, { rootId });
      hapticNotification(kind);
      const hostName = hostById(rootId)?.hostName ?? rootId;
      await Promise.all([
        loadInteractions(),
        loadObserve(),
        refreshHostInbox(rootId, hostName),
        refreshHostSessions(rootId, hostName),
      ]);
      return true;
    } catch (cause) {
      hapticNotification('error');
      showToast(cause instanceof Error ? cause.message : String(cause));
      return false;
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
      if (typeof page.through === 'number') lastThrough = Math.max(lastThrough, page.through);
      void loadHistory();
      return;
    }
    if (page.kind === 'events') {
      if (typeof page.through === 'number') lastThrough = Math.max(lastThrough, page.through);
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
          fact.kind === 'executor_tool_result'
        ) {
          needsHistory = true;
        } else if (fact.kind === 'ended') {
          needsHistory = true;
          needsObserve = true;
          livePreview.set(accumulator.reset());
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
    if (gen === activeGeneration && watchSubId) return;
    void refreshAll().then(() => {
      if (!disposed && activeHostInfo(rootId)) {
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
