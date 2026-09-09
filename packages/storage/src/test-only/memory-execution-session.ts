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
import { tmpdir } from 'node:os';
import {
  decodeCanonicalMessage,
  deriveTurnRecords,
  WORKHUB_COORDINATION_SESSION_ID as HUB,
  WORKHUB_COORDINATION_SESSION_ROLE,
  type SessionHeader,
  type StoredMessage,
  type WorkHubDelegationAssignedMessage,
  type WorkHubActionClaim,
} from '@maka/core/session';
import {
  messageContentDigest,
  messageContentsEqual,
  normalizeMessageContent,
} from '@maka/core/events';
import {
  createGenesisExecutionBoundary,
  decodeExecutionBoundary,
  assessSandboxBoundaryExpansion,
  validateSandboxBoundaryExpansion,
  isSandboxBoundaryRestartClosure,
  type ExecutionBoundary,
  type SandboxBoundaryRequest,
} from '@maka/core/sandbox-boundary';
import type { AgentGraphOperatorProvision } from '@maka/core/agent-graph-topology';
import { assertAgentGraphOperatorProvisionRequest } from '@maka/core/agent-graph-topology';
import {
  AgentGraphScheduleClosedError,
  AgentGraphScheduleRevisionConflictError,
  type AgentGraphScheduleUpdate,
} from '@maka/core/agent-graph-schedule';
import {
  assertSafeSessionId,
  SessionNotFoundError,
  SessionMetadataConflictError,
  SessionMetadataVersionConflictError,
  type SessionAuthorityStore,
  type SessionHeaderSnapshot,
  type SessionCatalogRecord,
  type CreateStableSessionRequest,
  type CoordinationTranscriptIndexRecord,
} from '../session-store-contract.js';
import { buildSessionHeader, normalizeSessionHeader, toSummary } from '../session-store-values.js';
import { isValidConversationCopyTransition } from '../session-conversation-copy.js';
import { memoryRootSourceReceipt } from './memory-execution-agent.js';
import {
  normalizePendingMessageAdmission,
  samePendingMessageAdmission,
  normalizeProvenRootMessageHandoff,
  normalizeProvenSteeringMessageHandoff,
  type PendingMessageAdmission,
} from '../message-admission-store.js';
import {
  projectSessionCatalogMessages,
  lastMessagePreviewForMessages,
} from '../session-message-projection.js';
import {
  type MemoryExecutionAuthority,
  copy,
  equal,
  key,
  digest,
  rows,
  type MemoryState,
} from './memory-execution-state.js';

type Header = SessionHeaderSnapshot;
const headers = (s: MemoryState) => rows<Header>(s, 'headers');
const messages = (s: MemoryState) => rows<StoredMessage[]>(s, 'messages');
const admissions = (s: MemoryState) => rows<PendingMessageAdmission>(s, 'admissions');
const suffix = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 48);
const conflict = (message: string): never => {
  throw new SessionMetadataConflictError(message);
};

export function requireHeader(s: MemoryState, id: string): Header {
  assertSafeSessionId(id);
  const h = headers(s).get(id);
  if (!h) throw new SessionNotFoundError(id);
  return h;
}
function boundary(s: MemoryState, id: string): ExecutionBoundary {
  requireHeader(s, id);
  return rows<ExecutionBoundary>(s, 'boundaries').get(id)!;
}
type ManagedProfile = Extract<ExecutionBoundary, { kind: 'managed' }>['profile'];
function genesisProfile(mode: 'ask' | 'explore'): ManagedProfile {
  const initial = createGenesisExecutionBoundary(mode);
  if (initial.kind !== 'managed') throw new Error('Expected managed genesis boundary');
  return initial.profile;
}
function isReadOnlyProfile(profile: ManagedProfile): boolean {
  const { name: _name, ...policy } = profile;
  const { name: _canonicalName, ...canonical } = genesisProfile('explore');
  return equal(policy, canonical);
}
function saveBoundary(s: MemoryState, id: string, value: ExecutionBoundary): void {
  rows<ExecutionBoundary>(s, 'boundaries').set(id, value);
  // Only the latest non-Explore managed boundary is needed to restore Auto.
  // Keep this history through Bypass/Explore instead of granting a new genesis.
  if (value.kind === 'managed' && !isReadOnlyProfile(value.profile))
    rows<ManagedProfile>(s, 'autoBoundaryProfiles').set(id, copy(value.profile));
}
function setBoundaryKind(
  s: MemoryState,
  id: string,
  kind: 'managed' | 'bypass',
  projection?: { permissionMode: SessionHeader['permissionMode']; labels?: readonly string[] },
  headerPatch: Partial<SessionHeader> = {},
  expectedVersion?: number,
): { boundary: ExecutionBoundary; record: Header } {
  const record = requireHeader(s, id);
  if (expectedVersion !== undefined && record.revision !== expectedVersion)
    throw new SessionMetadataVersionConflictError(id, expectedVersion, record.revision);
  const current = boundary(s, id);
  if (current.kind === 'external')
    conflict('An externally isolated session cannot enter Auto or Bypass');
  const permissionMode =
    projection?.permissionMode ??
    (kind === 'bypass'
      ? 'bypass'
      : record.header.permissionMode === 'bypass'
        ? 'ask'
        : record.header.permissionMode);
  if ((permissionMode === 'bypass') !== (kind === 'bypass'))
    throw new Error('Execution boundary kind and projected permission mode disagree');
  const profile =
    kind === 'managed'
      ? permissionMode === 'explore'
        ? genesisProfile('explore')
        : current.kind === 'managed' && !isReadOnlyProfile(current.profile)
          ? current.profile
          : (rows<ManagedProfile>(s, 'autoBoundaryProfiles').get(id) ?? genesisProfile('ask'))
      : undefined;
  let next = current;
  if (current.kind !== kind || (current.kind === 'managed' && !equal(current.profile, profile))) {
    next =
      kind === 'bypass'
        ? { kind, revision: current.revision + 1 }
        : { kind, profile: profile!, revision: current.revision + 1 };
    saveBoundary(s, id, next);
  }
  return {
    boundary: next,
    record: update(
      s,
      id,
      {
        ...headerPatch,
        permissionMode,
        labels: projection?.labels ? [...projection.labels] : record.header.labels,
      },
      expectedVersion,
      true,
    ),
  };
}
function insert(s: MemoryState, header: SessionHeader, initial?: ExecutionBoundary): Header {
  if (headers(s).has(header.id) || rows(s, 'tombstones').has(header.id))
    conflict('Session identity already used');
  const record = { header: normalizeSessionHeader(header), revision: 1, committedAt: Date.now() };
  headers(s).set(header.id, record);
  messages(s).set(header.id, []);
  rows(s, 'autoBoundaryProfiles').delete(header.id);
  saveBoundary(
    s,
    header.id,
    initial
      ? decodeExecutionBoundary(initial)
      : createGenesisExecutionBoundary(header.permissionMode),
  );
  return record;
}
function update(
  s: MemoryState,
  id: string,
  patch: Partial<SessionHeader>,
  version?: number,
  skipNoop = false,
): Header {
  const current = requireHeader(s, id);
  if (version !== undefined && current.revision !== version) {
    throw new SessionMetadataVersionConflictError(id, version, current.revision);
  }
  if (
    Object.hasOwn(patch, 'conversationCopy') &&
    !isValidConversationCopyTransition(current.header, patch.conversationCopy)
  )
    conflict('Session conversation-copy identity is immutable');
  const next = {
    header: normalizeSessionHeader({ ...current.header, ...copy(patch) }, id),
    revision: current.revision + 1,
    committedAt: Date.now(),
  };
  if (skipNoop && equal(next.header, current.header)) return current;
  headers(s).set(id, next);
  return next;
}
function updatePublic(
  s: MemoryState,
  id: string,
  patch: Partial<SessionHeader>,
  version?: number,
): Header {
  for (const field of [
    'subagentParent',
    'subagentRuntime',
    'subagentSpawn',
    'subagentWorkspace',
    'externalOrigin',
    'role',
    'isArchived',
  ]) {
    if (Object.hasOwn(patch, field))
      conflict('Session identity/lifecycle field requires its dedicated writer: ' + field);
  }
  return update(s, id, patch, version);
}
function catalog(s: MemoryState, id: string): SessionCatalogRecord {
  const record = requireHeader(s, id);
  const preview = rows<string>(s, 'previews').get(id);
  return {
    ...record,
    activityAt: record.header.lastMessageAt ?? record.header.createdAt,
    summary: {
      ...toSummary(record.header),
      ...(preview === undefined ? {} : { lastMessagePreview: preview }),
    },
  };
}
function project(s: MemoryState, id: string, values: readonly StoredMessage[]): void {
  const current = requireHeader(s, id);
  const projection = projectSessionCatalogMessages(values);
  const preview = lastMessagePreviewForMessages(values);
  if (preview !== undefined) rows(s, 'previews').set(id, preview);
  const visible = values.some((m) => m.type === 'user' || m.type === 'assistant');
  if (visible || projection.lastMessageAt !== undefined) {
    update(s, id, {
      ...(projection.lastMessageAt === undefined
        ? {}
        : { lastMessageAt: Math.max(current.header.lastMessageAt ?? 0, projection.lastMessageAt) }),
      ...(values.some((m) => m.type === 'user') ? { connectionLocked: true } : {}),
    });
  }
}
function append(s: MemoryState, id: string, inputs: readonly StoredMessage[]): void {
  requireHeader(s, id);
  const list = messages(s).get(id)!;
  for (const input of inputs) {
    const message = decodeCanonicalMessage(copy(input));
    const previous = list.find((m) => m.id === message.id);
    if (previous) {
      if (!equal(previous, message)) conflict('Message identity changed');
      continue;
    }
    list.push(message);
  }
  project(s, id, inputs);
}
function probe(s: MemoryState, id: string, fingerprint: string) {
  assertSafeSessionId(id);
  if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint)) conflict('Invalid Session create fingerprint');
  const claim = rows<string>(s, 'createClaims').get(id);
  if (rows(s, 'tombstones').has(id))
    return { kind: 'conflict' as const, reason: 'removed' as const };
  const record = headers(s).get(id);
  if (record || claim) {
    if (claim !== fingerprint)
      return { kind: 'conflict' as const, reason: 'identity_mismatch' as const };
    if (record) return { kind: 'existing' as const, record };
  }
  return { kind: 'absent' as const };
}
function stable(
  s: MemoryState,
  root: string,
  request: CreateStableSessionRequest,
  initial?: ExecutionBoundary,
) {
  const previous = probe(s, request.sessionId, request.requestFingerprint);
  if (previous.kind !== 'absent') return previous;
  const h = buildSessionHeader(
    root,
    request.input,
    request.sessionId,
    request.input.conversationCopy,
  );
  if (
    request.input.conversationCopy &&
    request.input.conversationCopy.requestFingerprint !== request.requestFingerprint
  )
    conflict('Copy fingerprint changed');
  if (request.input.subagentSpawn) conflict('Use subagent creation');
  rows(s, 'createClaims').set(h.id, request.requestFingerprint);
  return { kind: 'created' as const, record: insert(s, h, initial) };
}
function admit(s: MemoryState, input: PendingMessageAdmission): PendingMessageAdmission {
  const value = normalizePendingMessageAdmission(copy(input));
  requireHeader(s, value.sessionId);
  const id = key(value.sessionId, value.messageId);
  if (rows(s, 'cancelledAdmissions').has(id)) conflict('Message admission was cancelled');
  const old = admissions(s).get(id);
  if (old) {
    if (!samePendingMessageAdmission(old, value)) conflict('Message admission identity conflict');
    return old;
  }
  admissions(s).set(id, value);
  const orders = rows<number>(s, 'admissionOrder');
  const nextOrder =
    Math.max(
      -1,
      ...[...admissions(s).values()]
        .filter((v) => v.sessionId === value.sessionId && v.messageId !== value.messageId)
        .map((v) => orders.get(key(v.sessionId, v.messageId)) ?? 0),
    ) + 1;
  orders.set(id, nextOrder);
  return value;
}
function hubMessage(s: MemoryState, id: string): StoredMessage | undefined {
  return messages(s)
    .get(HUB)
    ?.find((m) => m.id === id);
}
function remove(s: MemoryState, id: string, group: Set<string>): void {
  const record = requireHeader(s, id);
  const provisions = [...rows<AgentGraphOperatorProvision>(s, 'graphProvisions').values()];
  const owned = provisions.find((p) => p.targetSessionId === id),
    parent = record.header.subagentParent;
  if (
    owned &&
    (!parent ||
      !group.has(parent.parentSessionId) ||
      parent.graph?.graphId !== owned.graphId ||
      parent.graph.workId !== owned.workId ||
      parent.graph.operatorId !== owned.operatorId)
  )
    conflict('Cannot remove graph operator outside its retirement unit');
  const children = [...headers(s).values()].filter(
    (h) =>
      h.header.subagentParent?.parentSessionId === id &&
      provisions.some((p) => p.targetSessionId === h.header.id),
  );
  if (children.some((h) => !group.has(h.header.id)))
    conflict('Session has live child Sessions outside retirement');
  headers(s).delete(id);
  messages(s).delete(id);
  rows(s, 'tombstones').set(id, true);
  rows(s, 'cleanup').set(id, true);
  rows(s, 'goals').delete(id);
  rows(s, 'boundaries').delete(id);
  rows(s, 'autoBoundaryProfiles').delete(id);
  for (const [k, a] of admissions(s)) if (a.sessionId === id) admissions(s).delete(k);
}
function spawn(s: MemoryState, header: SessionHeader, initial?: ExecutionBoundary) {
  const parent = header.subagentParent,
    intent = header.subagentSpawn;
  if (!parent || !intent || !header.subagentRuntime) conflict('Incomplete subagent identity');
  requireHeader(s, parent!.parentSessionId);
  const id = key(
    parent!.parentSessionId,
    parent!.spawnedBy.parentRunId,
    parent!.spawnedBy.toolCallId,
    parent!.swarm?.swarmId,
    parent!.swarm?.itemId,
  );
  const old = rows<{ sessionId: string; fingerprint: string; parent: typeof parent }>(
    s,
    'spawnClaims',
  ).get(id);
  if (old) {
    if (old.fingerprint !== intent!.requestFingerprint || !equal(old.parent, parent))
      conflict('Subagent spawn identity changed');
    return { header: requireHeader(s, old.sessionId).header, created: false };
  }
  const record = insert(s, header, initial);
  rows(s, 'spawnClaims').set(id, {
    sessionId: header.id,
    fingerprint: intent!.requestFingerprint,
    parent,
  });
  return { header: record.header, created: true };
}

export function createMemorySessionStore(
  a: MemoryExecutionAuthority,
  root: string,
): SessionAuthorityStore {
  const read = <T>(fn: (s: MemoryState) => T) => a.read(fn);
  const write = <T>(name: string, fn: (s: MemoryState) => T) => a.write(name, fn);
  const store: SessionAuthorityStore = {
    ready: async () => {},
    close: async () => {},
    create: async (input, initial) =>
      write('session.create', (s) => {
        if ('conversationCopy' in input || input.subagentSpawn)
          conflict('Use the identity-bound creation operation');
        return insert(s, buildSessionHeader(root, input), initial).header;
      }),
    createStableSession: async (request, initial) =>
      write('session.createStable', (s) => stable(s, root, request, initial)),
    probeStableSessionCreate: async (id, fingerprint) => read((s) => probe(s, id, fingerprint)),
    createImportedSession: async (input, values, origin) =>
      write('session.import', (s) => {
        const h = {
          ...buildSessionHeader(root, input),
          externalOrigin: copy(origin),
          transcriptLedgerVersion: 0 as const,
        };
        insert(s, h);
        append(s, h.id, values);
        return requireHeader(s, h.id).header;
      }),
    lookupExternalSessionImports: async (adapterId, sourceIds, limit) =>
      read((s) =>
        sourceIds.map((sourceSessionId) => {
          const matches = [...headers(s).values()].filter(
            (h) =>
              h.header.externalOrigin?.adapterId === adapterId &&
              h.header.externalOrigin.sourceSessionId === sourceSessionId,
          );
          return {
            sourceSessionId,
            livePublishedImportCount: matches.length,
            recentSessionIds: matches
              .sort((x, y) => y.header.createdAt - x.header.createdAt)
              .slice(0, limit)
              .map((h) => h.header.id),
          };
        }),
      ),
    createSubagent: async (input, initial) =>
      write('session.spawn', (s) => {
        if (input.subagentParent?.graph) conflict('Use atomic graph provisioning');
        return spawn(s, buildSessionHeader(root, input), initial);
      }),
    createAgentGraphOperator: async (input, request, expectedRevision, initial) =>
      write('session.graphProvision', (s) => {
        assertAgentGraphOperatorProvisionRequest(request);
        const h = buildSessionHeader(root, input);
        const g = h.subagentParent?.graph;
        if (
          !g ||
          g.graphId !== request.graphId ||
          g.workId !== request.workId ||
          g.operatorId !== request.operatorId ||
          h.subagentRuntime?.agentId !== request.agentId ||
          h.subagentSpawn?.initialTurnId !== request.initialTurnId ||
          h.subagentSpawn?.initialRunId !== request.initialRunId
        )
          conflict('Graph Session identity mismatch');
        const id = key(request.graphId, request.workId);
        const previous = rows<AgentGraphOperatorProvision>(s, 'graphProvisions').get(id);
        if (previous) {
          if (previous.provisionFingerprint !== request.provisionFingerprint)
            conflict('Graph provision identity changed');
          return {
            header: requireHeader(s, previous.targetSessionId).header,
            provision: previous,
            created: false,
          };
        }
        assertGraphRevision(s, request.graphId, expectedRevision);
        const child = spawn(s, h, initial);
        if (!child.created) conflict('Spawn already exists without graph provision');
        const provision = { ...copy(request), targetSessionId: h.id, provisionedAt: Date.now() };
        rows(s, 'graphProvisions').set(id, provision);
        return { header: h, provision, created: true };
      }),
    readHeader: async (id) => read((s) => requireHeader(s, id).header),
    readHeaderSnapshot: async (id) => read((s) => requireHeader(s, id).header),
    readHeaderRecordSnapshot: async (id) => read((s) => requireHeader(s, id)),
    readCatalogRecord: async (id) => read((s) => catalog(s, id)),
    listHeaders: async () =>
      read((s) =>
        [...headers(s).values()].map((h) => h.header).sort((x, y) => x.id.localeCompare(y.id)),
      ),
    listForRecovery: async () => store.listHeaders(),
    list: async (filter) => read((s) => selectCatalog(s, filter).map((r) => r.summary)),
    listCatalogPage: async (filter, cursor, limit, expectedRevision) =>
      read((s) => {
        if (!Number.isSafeInteger(limit) || limit < 1)
          throw new RangeError('Invalid catalog limit');
        const revision = digest([...headers(s).values()]);
        if (expectedRevision !== undefined && expectedRevision !== revision)
          return { kind: 'revision_changed', expectedRevision, actualRevision: revision };
        const all = selectCatalog(s, filter).filter(
          (r) =>
            !cursor ||
            r.activityAt < cursor.activityAt ||
            (r.activityAt === cursor.activityAt && r.header.id > cursor.sessionId),
        );
        return {
          kind: 'page',
          revision,
          records: all.slice(0, limit),
          hasMore: all.length > limit,
        };
      }),
    readMessages: async (id) =>
      read((s) => {
        requireHeader(s, id);
        return messages(s).get(id)!;
      }),
    readMessagesSnapshot: async (id) => store.readMessages(id),
    listTurns: async (id) => deriveTurnRecords(await store.readMessages(id)),
    listTurnsSnapshot: async (id) => store.listTurns(id),
    readTranscriptHighWaterSnapshot: async (id) =>
      read((s) => {
        requireHeader(s, id);
        const length = messages(s).get(id)!.length;
        return length ? length - 1 : null;
      }),
    readMessagesAfter: async (id, request) =>
      read((s) => {
        requireHeader(s, id);
        const all = messages(s).get(id)!;
        let selected = all
          .map((message, sequence) => ({ sequence, message }))
          .filter(
            (r) =>
              r.sequence > (request.afterSequence ?? -1) &&
              r.sequence < (request.beforeSequence ?? Infinity),
          );
        if (request.beforeSequence !== undefined) selected.reverse();
        let bytes = 0;
        const records = [];
        for (const r of selected.slice(0, request.maxMessages)) {
          const n = Buffer.byteLength(JSON.stringify(r.message));
          if (bytes + n > request.maxStoredBytes) break;
          bytes += n;
          records.push(r);
        }
        return { records, highWaterSequence: all.length ? all.length - 1 : null };
      }),
    readTranscriptMessagesSnapshot: async (id, request) =>
      read((s) => {
        requireHeader(s, id);
        const selected = messages(s)
          .get(id)!
          .filter(
            (m, i) => i <= (request.throughSequence ?? -1) && request.messageIds.includes(m.id),
          );
        if (
          selected.length > request.maxMessages ||
          selected.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0) > request.maxBytes
        )
          throw new RangeError('Transcript read budget exceeded');
        return selected;
      }),
    appendMessage: async (id, value) => store.appendMessages(id, [value]),
    appendMessages: async (id, values) => {
      write('session.append', (s) => append(s, id, values));
      a.notify(id);
    },
    commitMessageCatalogProjection: async (id, value) => {
      write('session.project', (s) => project(s, id, [value]));
    },
    updateHeader: async (id, patch) =>
      write('session.update', (s) => updatePublic(s, id, patch).header),
    updateHeaderVersioned: async (id, patch, version) =>
      write('session.updateVersioned', (s) => updatePublic(s, id, patch, version)),
    updateSessionConfiguration: async (id, input) =>
      write('session.configure', (s) => {
        const record = requireHeader(s, id);
        if (record.revision !== input.expectedVersion)
          throw new SessionMetadataVersionConflictError(id, input.expectedVersion, record.revision);
        if (input.lifecycle.kind === 'clear_connection_block') {
          if (record.header.blockedReason !== 'NO_REAL_CONNECTION')
            conflict('Session no longer has a connection block to clear');
          if (
            !Number.isSafeInteger(input.lifecycle.statusUpdatedAt) ||
            input.lifecycle.statusUpdatedAt < 0
          )
            throw new Error('Session connection unblock timestamp is invalid');
        }
        return setBoundaryKind(
          s,
          id,
          input.configuration.permissionMode === 'bypass' ? 'bypass' : 'managed',
          input.configuration,
          {
            ...input.configuration,
            labels: [...input.configuration.labels],
            ...(input.lifecycle.kind === 'clear_connection_block'
              ? {
                  status: 'active',
                  blockedReason: undefined,
                  statusUpdatedAt: input.lifecycle.statusUpdatedAt,
                }
              : {}),
          },
          input.expectedVersion,
        ).record;
      }),
    setFlagged: async (id, value) => {
      await store.updateHeader(id, { isFlagged: value });
    },
    rename: async (id, name) => {
      await store.updateHeader(id, { name, titleIsManual: true });
    },
    setGeneratedTitleIfAbsent: async (id, title) =>
      write('session.title', (s) => {
        const h = requireHeader(s, id).header;
        if (h.titleIsManual || h.name !== 'New Chat' || h.name === title) return null;
        return update(s, id, { name: title }).header;
      }),
    probeSessionRemoval: async (id) =>
      read((s) =>
        headers(s).has(id)
          ? { kind: 'present', record: requireHeader(s, id) }
          : rows(s, 'tombstones').has(id)
            ? { kind: 'removed' }
            : { kind: 'absent' },
      ),
    remove: async (id) => {
      write('session.remove', (s) => remove(s, id, new Set([id])));
    },
    setSessionsArchivedVersioned: async (ids, isArchived) =>
      write('session.archive', (s) =>
        ids.map(({ sessionId, expectedVersion }) => {
          const result = update(s, sessionId, { isArchived }, expectedVersion, true);
          if (isArchived) rows(s, 'goals').delete(sessionId);
          return result;
        }),
      ),
    removeSessionsVersioned: async (ids, archive = []) =>
      write('session.retire', (s) => {
        const group = new Set(ids.map((i) => i.sessionId));
        for (const i of [...ids, ...archive]) {
          if (rows(s, 'tombstones').has(i.sessionId) && group.has(i.sessionId)) continue;
          const h = requireHeader(s, i.sessionId);
          if (h.revision !== i.expectedVersion)
            throw new SessionMetadataVersionConflictError(
              i.sessionId,
              i.expectedVersion,
              h.revision,
            );
        }
        for (const i of archive) {
          if (group.has(i.sessionId)) conflict('Cannot archive and remove the same Session');
          update(s, i.sessionId, { isArchived: true }, undefined, true);
          rows(s, 'goals').delete(i.sessionId);
        }
        for (const i of ids) if (headers(s).has(i.sessionId)) remove(s, i.sessionId, group);
        return [...group];
      }),
    listPendingSessionRetirementCleanupIds: async (id) =>
      read((s) =>
        [...rows(s, 'cleanup').keys()].filter((x) => id === undefined || x === id).sort(),
      ),
    completeSessionRetirementCleanup: async (id) => {
      write('session.cleanupComplete', (s) => {
        rows(s, 'cleanup').delete(id);
      });
    },
    reconcileOrphanedAgentGraphRetirements: async () =>
      write('session.reconcileRetirement', (s) => {
        const ids = [...headers(s).values()]
          .filter(
            (h) =>
              h.header.subagentParent?.graph &&
              rows(s, 'tombstones').has(h.header.subagentParent.parentSessionId),
          )
          .map((h) => h.header.id);
        for (const id of ids) remove(s, id, new Set(ids));
        return ids;
      }),
    discardStableConversationCopy: async (id, fingerprint) =>
      write('session.discardCopy', (s) => {
        const p = probe(s, id, fingerprint);
        if (p.kind !== 'existing' || !p.record.header.conversationCopy) return false;
        if (
          messages(s).get(id)?.length ||
          [...admissions(s).values()].some((x) => x.sessionId === id)
        )
          return false;
        headers(s).delete(id);
        messages(s).delete(id);
        rows(s, 'createClaims').delete(id);
        rows(s, 'boundaries').delete(id);
        rows(s, 'autoBoundaryProfiles').delete(id);
        return true;
      }),
    commitMessageAdmission: async (input) => write('message.admit', (s) => admit(s, input)),
    readMessageAdmission: async (id, messageId) =>
      read((s) => admissions(s).get(key(id, messageId))),
    listMessageAdmissions: async (id) =>
      read((s) => {
        assertSafeSessionId(id);
        const order = rows<number>(s, 'admissionOrder');
        return [...admissions(s).values()]
          .filter((x) => x.sessionId === id)
          .sort(
            (a, b) =>
              (order.get(key(id, a.messageId)) ?? 0) - (order.get(key(id, b.messageId)) ?? 0),
          );
      }),
    hasCancelledMessageAdmission: async (id, messageId) =>
      read((s) => rows(s, 'cancelledAdmissions').has(key(id, messageId))),
    claimMessageAdmissionCancellation: async (id, messageId, claimId) =>
      write('message.cancelClaim', (s) => {
        [id, messageId, claimId].forEach(assertSafeSessionId);
        const k = key(id, messageId),
          prior = rows<string>(s, 'cancelledAdmissions').get(k);
        if (prior !== undefined) return prior === claimId ? 'same_claim' : 'already_cancelled';
        if (!admissions(s).has(k)) conflict('Message admission cancellation identity conflict');
        admissions(s).delete(k);
        rows(s, 'cancelledAdmissions').set(k, claimId);
        return 'cancelled_by_claim';
      }),
    cancelMessageAdmissions: async (id, ids) => {
      write('message.cancel', (s) => {
        [id, ...ids].forEach(assertSafeSessionId);
        for (const messageId of new Set(ids)) {
          const k = key(id, messageId);
          if (!admissions(s).has(k) && !rows(s, 'cancelledAdmissions').has(k))
            conflict('Message admission cancellation identity conflict');
          admissions(s).delete(k);
          if (!rows(s, 'cancelledAdmissions').has(k)) rows(s, 'cancelledAdmissions').set(k, '');
        }
      });
    },
    updateMessageAdmission: async (input) => {
      write('message.update', (s) => {
        const value = normalizePendingMessageAdmission(copy(input)),
          k = key(value.sessionId, value.messageId),
          old = admissions(s).get(k);
        if (
          !old ||
          old.turnId !== value.turnId ||
          old.runId !== value.runId ||
          old.submittedPlacement !== value.submittedPlacement ||
          old.admittedAt !== value.admittedAt
        )
          conflict('Admission update identity conflict');
        admissions(s).set(k, {
          ...value,
          ...(old?.submittedIntent
            ? { submittedIntent: old.submittedIntent }
            : { submittedIntent: undefined }),
        });
      });
    },
    reorderMessageAdmissions: async (id, ids) => {
      write('message.reorder', (s) => {
        assertSafeSessionId(id);
        ids.forEach(assertSafeSessionId);
        const all = [...admissions(s).values()].filter(
          (x) => x.sessionId === id && x.disposition === 'followup',
        );
        if (
          new Set(ids).size !== ids.length ||
          ids.length !== all.length ||
          ids.some((x) => !all.some((v) => v.messageId === x))
        )
          conflict('Admission order mismatch');
        ids.forEach((mid, index) => rows<number>(s, 'admissionOrder').set(key(id, mid), index));
      });
    },
    markMessagesHandedOff: async (input) => {
      write('message.handoff', (s) => {
        [input.sessionId, input.turnId, ...input.messageIds].forEach(assertSafeSessionId);
        const requested = new Set(input.messageIds);
        const roots = new Map(
          (input.provenRootMessages ?? []).map((p) => {
            const v = normalizeProvenRootMessageHandoff(p);
            return [v.messageId, v] as const;
          }),
        );
        const steerings = new Map(
          (input.provenSteeringMessages ?? []).map((p) => {
            const v = normalizeProvenSteeringMessageHandoff(p);
            return [v.messageId, v] as const;
          }),
        );
        if (
          roots.size !== (input.provenRootMessages?.length ?? 0) ||
          steerings.size !== (input.provenSteeringMessages?.length ?? 0)
        )
          conflict('Duplicate handoff proof');
        if ([...roots.keys(), ...steerings.keys()].some((id) => !requested.has(id)))
          conflict('Handoff proof is not requested');
        if ([...steerings.values()].some((p) => p.executionTurnId !== input.turnId))
          conflict('Steering execution Turn conflict');
        for (const mid of new Set(input.messageIds)) {
          const k = key(input.sessionId, mid),
            admission = admissions(s).get(k);
          const root = roots.get(mid),
            steering = steerings.get(mid);
          if (!admission) {
            if (rows(s, 'cancelledAdmissions').has(k))
              conflict('Message admission already cancelled');
            if (!root && !steering) conflict('Message admission does not exist');
            continue;
          }
          const proven =
            steering &&
            admission.disposition === 'steering' &&
            admission.turnId === steering.admissionTurnId &&
            admission.runId === steering.admissionRunId &&
            admission.admittedAt === steering.admittedAt &&
            messageContentsEqual(admission.content, steering.content);
          if (steering && !proven) conflict('Steering admission identity conflict');
          if (admission.turnId !== input.turnId && admission.disposition !== 'followup' && !proven)
            conflict('Message admission Turn conflict');
          if (root && !messageContentsEqual(root.content, admission.content))
            conflict('Root handoff content mismatch');
          admissions(s).delete(k);
        }
      });
    },
    claimWorkHubAction: async (claim) =>
      write('workhub.claim', (s) => {
        assertSafeSessionId(claim.actionId);
        assertSafeSessionId(claim.subject);
        if (!/^sha256:[a-f0-9]{64}$/.test(claim.actionFingerprint))
          conflict('Invalid action fingerprint');
        const old = rows<WorkHubActionClaim>(s, 'workhubClaims').get(claim.actionId);
        if (old) return equal(old, claim) ? 'same_claim' : 'conflict';
        rows(s, 'workhubClaims').set(claim.actionId, copy(claim));
        return 'claimed';
      }),
    readWorkHubActionClaim: async (id) =>
      read((s) => rows<WorkHubActionClaim>(s, 'workhubClaims').get(id)),
    readWorkHubAssignment: async (id) =>
      read((s) => {
        const m = hubMessage(s, 'wha_' + suffix(id));
        return m?.type === 'workhub_coordination' && m.kind === 'delegation_assigned'
          ? m
          : undefined;
      }),
    readWorkHubReplacement: async (id) =>
      read((s) => {
        const m = hubMessage(s, 'whp_' + suffix(id));
        return m?.type === 'workhub_coordination' && m.kind === 'delegation_replacement_requested'
          ? m
          : undefined;
      }),
    readWorkHubReplacementAbort: async (id) =>
      read((s) => {
        const m = hubMessage(s, 'whb_' + suffix(id));
        return m?.type === 'workhub_coordination' && m.kind === 'delegation_replacement_aborted'
          ? m
          : undefined;
      }),
    readWorkHubSupersession: async (id) =>
      read((s) => {
        const m = hubMessage(s, 'whx_' + suffix(id));
        return m?.type === 'workhub_coordination' && m.kind === 'delegation_superseded'
          ? m
          : undefined;
      }),
    readWorkHubStopRequest: async (id) =>
      read((s) => {
        const m = hubMessage(s, 'whq_' + suffix(id));
        return m?.type === 'workhub_coordination' && m.kind === 'delegation_stop_requested'
          ? m
          : undefined;
      }),
    readWorkHubStopResolution: async (id) =>
      read((s) => {
        const m = hubMessage(s, 'whz_' + suffix(id));
        return m?.type === 'workhub_coordination' && m.kind === 'delegation_stop_resolved'
          ? m
          : undefined;
      }),
    readActiveWorkHubAssignmentsByTarget: async (ids, limit) =>
      read((s) => {
        ids.forEach(assertSafeSessionId);
        if (
          ids.length > 256 ||
          (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 256))
        )
          throw new Error('Invalid WorkHub target linkage bound');
        const counts = new Map<string, number>();
        return [...(messages(s).get(HUB) ?? [])]
          .reverse()
          .filter((m): m is WorkHubDelegationAssignedMessage => {
            if (
              m.type !== 'workhub_coordination' ||
              m.kind !== 'delegation_assigned' ||
              !ids.includes(m.targetSessionId) ||
              hubMessage(s, 'whx_' + suffix(m.delegationId)) ||
              hubMessage(s, 'whb_' + suffix(m.delegationId)) ||
              (!admissions(s).has(key(m.targetSessionId, m.targetMessageId)) &&
                !rows(s, 'cancelledAdmissions').has(key(m.targetSessionId, m.targetMessageId)) &&
                !memoryRootSourceReceipt(s, m.targetSessionId, m.targetMessageId))
            )
              return false;
            const resolution = hubMessage(s, 'whz_' + suffix(m.delegationId));
            if (
              resolution?.type === 'workhub_coordination' &&
              resolution.kind === 'delegation_stop_resolved' &&
              resolution.outcome !== 'not_owned'
            )
              return false;
            const count = counts.get(m.targetSessionId) ?? 0;
            counts.set(m.targetSessionId, count + 1);
            return limit === undefined || count < limit;
          });
      }),
    assignWorkHubMessage: async (request) => {
      const result = write('workhub.assign', (s) => {
        const assignment = decodeCanonicalMessage(copy(request.assignment));
        if (assignment.type !== 'workhub_coordination' || assignment.kind !== 'delegation_assigned')
          conflict('Invalid assignment');
        const v = assignment as WorkHubDelegationAssignedMessage,
          admission = normalizePendingMessageAdmission(copy(request.admission));
        const source = v.attachments ?? [],
          target = admission.content.attachments ?? [],
          hash = suffix(v.actionId);
        if (
          source.length !== target.length ||
          source.some(
            (x, i) =>
              x.ref.kind !== 'session_file' ||
              x.ref.sessionId !== HUB ||
              target[i]!.ref.kind !== 'session_file' ||
              target[i]!.ref.sessionId !== v.targetSessionId,
          )
        )
          conflict('Attachment ownership mismatch');
        if (
          v.targetSessionId === HUB ||
          v.targetSessionId !== admission.sessionId ||
          v.targetTurnId !== admission.turnId ||
          v.targetMessageId !== admission.messageId ||
          v.id !== 'wha_' + hash ||
          v.targetMessageId !== 'whm_' + hash ||
          v.delegationId !== 'whd_' + hash ||
          !messageContentsEqual(
            admission.content,
            normalizeMessageContent({
              text: v.userText,
              attachments: source.map((x, i) => ({ ...x, ref: target[i]!.ref })),
            }),
          ) ||
          admission.submittedContentDigest !== messageContentDigest(admission.content) ||
          admission.submittedPlacement !== 'current_turn' ||
          admission.placement !== 'current_turn' ||
          admission.disposition !== 'steering'
        )
          conflict('Assignment identity mismatch');
        const hub = requireHeader(s, HUB).header;
        if (hub.role !== WORKHUB_COORDINATION_SESSION_ROLE || hub.isArchived)
          conflict('Coordination Session unavailable');
        const prior = hubMessage(s, v.id);
        if (prior) {
          if (prior.type !== 'workhub_coordination' || prior.kind !== 'delegation_assigned')
            throw new SessionMetadataConflictError('Action identity conflict');
          if (!equal(assignmentIdentity(prior), assignmentIdentity(v)))
            conflict('Action identity conflict');
          return { kind: 'existing' as const, targetCreated: false, assignment: prior };
        }
        if ((v.disposition === 'create_new') !== Boolean(request.create))
          conflict('Create disposition mismatch');
        if (
          Boolean(v.replacesDelegationId) !== Boolean(request.supersession) ||
          Boolean(v.replacesActionId) !== Boolean(request.supersession)
        )
          conflict('Supersession missing');
        if (request.supersession) {
          const x = decodeCanonicalMessage(copy(request.supersession));
          if (
            x.type !== 'workhub_coordination' ||
            x.kind !== 'delegation_superseded' ||
            x.id !== 'whx_' + suffix(v.replacesDelegationId!) ||
            x.actionId !== v.actionId ||
            x.actionFingerprint !== v.actionFingerprint ||
            x.replacementDelegationId !== v.delegationId ||
            x.supersededDelegationId !== v.replacesDelegationId ||
            x.supersededActionId !== v.replacesActionId
          )
            conflict('Invalid supersession');
          const prior = hubMessage(s, 'wha_' + suffix(v.replacesActionId!));
          if (
            prior?.type !== 'workhub_coordination' ||
            prior.kind !== 'delegation_assigned' ||
            prior.delegationId !== v.replacesDelegationId ||
            hubMessage(s, x.id) ||
            hubMessage(s, 'whb_' + suffix(v.replacesDelegationId!))
          )
            conflict('Supersession source unavailable');
          if (hubMessage(s, 'whq_' + suffix(v.replacesDelegationId!))) {
            const resolution = hubMessage(s, 'whz_' + suffix(v.replacesDelegationId!));
            if (
              resolution?.type !== 'workhub_coordination' ||
              resolution.kind !== 'delegation_stop_resolved' ||
              resolution.outcome !== 'not_owned'
            )
              conflict('Stop already claimed');
          }
        }
        let targetCreated = false;
        if (request.create) {
          if (request.create.sessionId !== v.targetSessionId) conflict('Create target mismatch');
          const created = stable(s, root, request.create);
          if (created.kind === 'conflict') conflict('Create identity conflict');
          targetCreated = created.kind === 'created';
        }
        const h = requireHeader(s, v.targetSessionId).header;
        if (h.isArchived || h.status === 'waiting_for_user') conflict('Target unavailable');
        if (
          h.name !== v.targetSessionName &&
          !(v.disposition === 'delegate_existing' && v.replacesDelegationId)
        )
          conflict('Target display identity changed');
        if (admissions(s).has(key(admission.sessionId, admission.messageId)))
          conflict('Message identity already admitted');
        admit(s, admission);
        const committed = { ...v, targetSessionName: h.name };
        append(s, HUB, [committed, ...(request.supersession ? [request.supersession] : [])]);
        return { kind: 'assigned' as const, targetCreated, assignment: committed };
      });
      if (result.kind === 'assigned') a.notify(HUB);
      return result;
    },
    subscribeTranscriptChanges: (listener) => {
      a.listeners.add(listener);
      return () => {
        a.listeners.delete(listener);
      };
    },
    readCoordinationTranscriptIndexState: async () =>
      read((s) => {
        const list = [...rows<CoordinationTranscriptIndexRecord>(s, 'coordIndex').values()];
        const last = (source: 'legacy' | 'runtime') => {
          const v = list.filter((x) => x.source === source);
          return v.length ? Math.max(...v.map((x) => x.sourceSequence)) : null;
        };
        return {
          highWater: list.length ? list.length - 1 : null,
          legacy: last('legacy'),
          runtime: last('runtime'),
        };
      }),
    appendCoordinationTranscriptIndex: async (refs) => {
      write('session.coordIndex', (s) => {
        const table = rows<CoordinationTranscriptIndexRecord>(s, 'coordIndex');
        for (const ref of refs) {
          const k = key(ref.source, ref.sourceSequence);
          if (!table.has(k)) table.set(k, { ...copy(ref), sequence: table.size });
        }
      });
    },
    readCoordinationTranscriptIndex: async (request) =>
      read((s) => {
        const list = [...rows<CoordinationTranscriptIndexRecord>(s, 'coordIndex').values()].filter(
          (x) =>
            x.sequence <= request.throughSequence &&
            (request.direction === 'older'
              ? x.sequence <= request.position
              : x.sequence >= request.position),
        );
        if (request.direction === 'older') list.reverse();
        return list.slice(0, request.limit);
      }),
    readExecutionBoundary: async (id) => read((s) => boundary(s, id)),
    setExecutionBoundaryKind: async (id, kind, projection) =>
      write('session.boundary', (s) => setBoundaryKind(s, id, kind, projection).boundary),
    createSandboxBoundaryRequest: async (input) =>
      write('session.boundaryRequest', (s) => {
        assertSafeSessionId(input.requestId);
        const current = boundary(s, input.sessionId),
          k = key(input.sessionId, input.requestId),
          table = rows<SandboxBoundaryRequest>(s, 'boundaryRequests');
        const old = table.get(k);
        if (old) {
          if (
            !equal(old.expansion, input.expansion) ||
            old.turnId !== input.turnId ||
            old.runId !== input.runId
          )
            conflict('Boundary request identity conflict');
          return old;
        }
        const validation = validateSandboxBoundaryExpansion(input.expansion);
        if (!validation.ok) throw new Error('Invalid boundary expansion');
        const request = {
          ...copy(input),
          baseRevision: current.revision,
          status: 'pending' as const,
          createdAt: Date.now(),
        };
        table.set(k, request);
        return request;
      }),
    readSandboxBoundaryRequest: async (id, requestId) =>
      read((s) => rows<SandboxBoundaryRequest>(s, 'boundaryRequests').get(key(id, requestId))),
    listPendingSandboxBoundaryRequests: async (id) =>
      read((s) =>
        [...rows<SandboxBoundaryRequest>(s, 'boundaryRequests').values()].filter(
          (r) => r.sessionId === id && r.status === 'pending',
        ),
      ),
    listSandboxBoundaryRestartClosures: async (id) =>
      read((s) =>
        [...rows<SandboxBoundaryRequest>(s, 'boundaryRequests').values()].filter(
          (r) => r.sessionId === id && isSandboxBoundaryRestartClosure(r),
        ),
      ),
    hasExplicitSandboxBoundaryDenial: async (identities) =>
      read((s) =>
        [...rows<SandboxBoundaryRequest>(s, 'boundaryRequests').values()].some(
          (r) =>
            r.status === 'denied' &&
            r.outcomeReason === 'client_denied' &&
            identities.some(
              (i) => i.sessionId === r.sessionId && i.runId === r.runId && i.turnId === r.turnId,
            ),
        ),
      ),
    settleSandboxBoundaryRequest: async (input) =>
      write('session.boundarySettle', (s) => {
        const k = key(input.sessionId, input.requestId),
          table = rows<SandboxBoundaryRequest>(s, 'boundaryRequests'),
          request = table.get(k);
        if (!request) conflict('Boundary request missing');
        let current = boundary(s, input.sessionId),
          changed = false;
        if (request!.status !== 'pending') return { request: request!, boundary: current, changed };
        let settled: SandboxBoundaryRequest;
        if (input.decision === 'deny')
          settled = {
            ...request!,
            status: 'denied',
            outcomeReason: input.closureReason ?? 'client_denied',
            settledAt: Date.now(),
          };
        else if (current.kind !== 'managed')
          settled = {
            ...request!,
            status: 'conflict',
            outcomeReason: 'boundary_kind_changed',
            settledAt: Date.now(),
          };
        else {
          const assessment = assessSandboxBoundaryExpansion(current.profile, request!.expansion, {
            root: requireHeader(s, input.sessionId).header.cwd,
            tmpdir: tmpdir(),
            slashTmp: '/tmp',
          });
          if (assessment.outcome === 'conflict')
            settled = {
              ...request!,
              status: 'conflict',
              outcomeReason: assessment.reason,
              settledAt: Date.now(),
            };
          else {
            changed = assessment.outcome === 'apply';
            if (changed) {
              current = { ...current, profile: assessment.profile, revision: current.revision + 1 };
              saveBoundary(s, input.sessionId, current);
            }
            settled = {
              ...request!,
              status: 'approved',
              settledAt: Date.now(),
              appliedRevision: current.revision,
            };
          }
        }
        table.set(k, settled);
        return { request: settled, boundary: current, changed };
      }),
  };
  return store;
}
function assignmentIdentity(v: WorkHubDelegationAssignedMessage) {
  return {
    actionId: v.actionId,
    actionFingerprint: v.actionFingerprint,
    coordinationTurnId: v.coordinationTurnId,
    targetSessionId: v.targetSessionId,
    disposition: v.disposition,
    userText: v.userText,
    attachments: v.attachments ?? [],
    create: v.create,
    replacesActionId: v.replacesActionId,
    replacesDelegationId: v.replacesDelegationId,
  };
}
function selectCatalog(s: MemoryState, filter: Parameters<SessionAuthorityStore['list']>[0]) {
  return [...headers(s).values()]
    .filter(
      (r) =>
        r.header.role !== WORKHUB_COORDINATION_SESSION_ROLE &&
        (filter?.subagentParentSessionId
          ? r.header.subagentParent?.parentSessionId === filter.subagentParentSessionId
          : !r.header.subagentParent),
    )
    .map((r) => catalog(s, r.header.id))
    .sort((x, y) => y.activityAt - x.activityAt || x.header.id.localeCompare(y.header.id));
}
export function assertGraphRevision(s: MemoryState, graphId: string, expected: number): void {
  const updates = [...rows<AgentGraphScheduleUpdate>(s, 'graphUpdates').values()].filter(
    (x) => x.graphId === graphId,
  );
  const actual = updates.at(-1)?.revision ?? 0;
  if (actual !== expected)
    throw new AgentGraphScheduleRevisionConflictError(graphId, expected, actual);
  if (updates.some((x) => x.finish)) throw new AgentGraphScheduleClosedError(graphId);
}
