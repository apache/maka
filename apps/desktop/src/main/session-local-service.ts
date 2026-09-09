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

import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { IpcMain } from 'electron';
import { MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import type { CreateSessionRequestInput } from '@maka/core/runtime-inputs';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import type {
  TurnMessageSubmitInput,
  TurnMessageSubmitResult,
  WorkspaceTarget,
} from '@maka/runtime-host/protocol';
import type {
  DesktopLocalMessage,
  DesktopCachedTranscript,
  DesktopLocalMessageDraft,
} from '../shared/session-local-contract.js';
import type { DesktopSessionSummaryInput } from '../shared/desktop-session-projection.js';
import {
  requireDesktopTargetScope,
  type DesktopTargetScope,
} from '../shared/runtime-host-identity.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { normalizeSessionSendCommand } from './permission-response-guard.js';
import type { AttachmentApprovalRegistry } from './attachment-approval.js';
import { resolveAttachmentRefs, prepareIngestItems } from './attachment-ingest.js';
import { mergeWorkspaceFileInlineReferences } from './session-workspace-inline-references.js';
import {
  resolveDesktopSessionCreateInput,
  toDesktopHostSessionSummary,
} from './runtime-host-session-catalog-ipc-main.js';
import { encodeDesktopTranscriptSnapshot } from './desktop-transcript-ipc.js';
import {
  DesktopSessionLocalStore,
  MAX_LOCAL_MESSAGE_BYTES,
  type LocalOutboxRecord,
} from './session-local-store.js';
import type { DesktopTranscriptReplicaSnapshot } from './desktop-transcript-replica.js';

export interface DesktopSessionLocalTarget {
  readonly partition: string;
  readonly scope: DesktopTargetScope;
  readonly profileId: string;
  readonly client?: Pick<
    DesktopRuntimeHostClient,
    'hostEpoch' | 'createSession' | 'getSession' | 'listSessions' | 'ingestAttachment'
  >;
  readonly submit?: (input: TurnMessageSubmitInput) => Promise<TurnMessageSubmitResult>;
}

/** Includes the credential's lifetime without persisting a reusable secret. */
export function desktopSessionLocalPartition(input: {
  profileId: string;
  hostId: string;
  incarnation?: string;
  credential?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.profileId,
        input.hostId,
        input.incarnation ?? '',
        input.credential ?? 'local-owner',
      ]),
    )
    .digest('hex');
}

export class DesktopSessionLocalService {
  readonly #checking = new Set<string>();
  readonly #running = new Set<string>();
  readonly #probed = new Map<string, DesktopSessionLocalTarget['client']>();
  readonly #retries = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #snapshots = new Map<
    string,
    { target: DesktopSessionLocalTarget; snapshot: DesktopTranscriptReplicaSnapshot }
  >();
  readonly #catalogTasks = new Map<string, Promise<void>>();
  readonly #catalogFresh = new Map<string, { epoch: string; at: number }>();
  readonly #revoked = new Set<string>();
  #scheduled = false;
  #closed = false;
  #targetCursor = 0;

  constructor(
    readonly store: DesktopSessionLocalStore,
    private readonly deps: {
      targets(): readonly DesktopSessionLocalTarget[];
      changed(scope: DesktopTargetScope, sessionId?: string): void;
      onError(error: unknown): void;
    },
  ) {}

  target(scope: unknown): DesktopSessionLocalTarget {
    const requested = requireDesktopTargetScope(scope);
    const target = this.deps
      .targets()
      .find(
        (target) =>
          target.scope.hostId === requested.hostId &&
          target.scope.targetEpoch === requested.targetEpoch,
      );
    if (!target || this.#revoked.has(target.partition))
      throw new Error('The local intent belongs to a removed or different Host authority');
    return target;
  }

  changed(scope?: DesktopTargetScope): void {
    if (scope) {
      const target = this.deps
        .targets()
        .find(
          (target) =>
            target.scope.hostId === scope.hostId && target.scope.targetEpoch === scope.targetEpoch,
        );
      if (target) this.#catalogFresh.delete(target.partition);
    }
    this.wake();
  }

  wake(): void {
    if (this.#closed || this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      const targets = this.deps.targets().filter((target) => !this.#revoked.has(target.partition));
      const retainedKeys = new Set(
        targets.flatMap((target) =>
          this.store
            .list(target.partition)
            .map((record) => `${target.partition}:${record.messageId}`),
        ),
      );
      for (const key of this.#probed.keys()) if (!retainedKeys.has(key)) this.#probed.delete(key);
      const ordered = [
        ...targets.slice(this.#targetCursor),
        ...targets.slice(0, this.#targetCursor),
      ];
      for (const target of ordered) {
        if (this.#running.size >= 2) break;
        if (!target.client || !target.submit || this.#running.has(target.partition)) continue;
        const blockedSessions = new Set<string>();
        const record = this.store.list(target.partition).find((record) => {
          // Settled messages retain their local copy without reserving delivery order.
          // Unresolved Host outcomes must still hold later messages behind them.
          if (record.state === 'accepted' || record.state === 'failed') return false;
          if (blockedSessions.has(record.sessionId)) return false;
          blockedSessions.add(record.sessionId);
          return this.#probed.get(`${target.partition}:${record.messageId}`) !== target.client;
        });
        if (!record) continue;
        this.#targetCursor = (targets.indexOf(target) + 1) % targets.length;
        this.#running.add(target.partition);
        void this.#deliver(target, record)
          .catch(this.deps.onError)
          .finally(() => {
            this.#running.delete(target.partition);
            this.#checking.delete(`${target.partition}:${record.messageId}`);
            this.wake();
          });
      }
    });
  }

  listMessages(target: DesktopSessionLocalTarget, sessionId: string): DesktopLocalMessage[] {
    return this.store.list(target.partition, sessionId).map((record) => ({
      sessionId,
      messageId: record.messageId,
      createdAt: record.createdAt,
      state: record.state,
      canCancel:
        (!record.intent.originHostEpoch && record.state !== 'accepted') ||
        record.state === 'failed',
      placement: record.intent.command.placement,
      text: record.intent.command.content.displayText ?? record.intent.command.content.text,
      attachments: record.intent.command.content.attachments ?? [],
      directoryReferences: record.intent.command.content.directoryReferences,
      quotes: record.intent.command.content.quotes,
      inlineReferences: record.intent.command.content.inlineReferences ?? [],
      ...(record.result?.disposition === 'turn_started' ? { turnId: record.result.turnId } : {}),
      ...(record.result && record.result.disposition !== 'blocked'
        ? { admission: record.result.disposition } : {}),
      checking: this.#checking.has(`${target.partition}:${record.messageId}`),
      retryScheduled: this.#retries.has(`${target.partition}:${record.messageId}`),
      waitingForConnection: !target.client || !target.submit,
      ...(record.error ? { error: record.error } : {}),
    }));
  }

  readFailedMessage(
    target: DesktopSessionLocalTarget, sessionId: string, messageId: string,
  ): DesktopLocalMessageDraft {
    const record = this.store.get(target.partition, messageId);
    if (!record || record.sessionId !== sessionId || record.state !== 'failed') {
      throw new Error('Only a definitively failed message can be edited');
    }
    const { command } = record.intent;
    // Recovery uses the original input, never a lossy display summary. Explicit
    // skill selections must remain editable input on the normal send path.
    const skillTokens = (command.skillIds ?? []).filter(
      (id) => !command.content.text.split(/\s+/).includes(`/skill:${id}`),
    ).map((id) => `/skill:${id}`);
    // The composer strips a one-shot orchestration command before admission.
    // Restore it before skill tokens so the normal slash-command path consumes it again.
    const mode = command.turnOrchestration?.mode;
    const tokens = [...(mode === 'swarm' || mode === 'graph' ? [`/${mode}`] : []), ...skillTokens];
    const prefix = tokens.length ? `${tokens.join(' ')} ` : '';
    return {
      messageId,
      text: prefix + command.content.text,
      attachments: command.content.attachments ?? [],
      stagedAttachments: this.store.stagedAttachments(target.partition, messageId),
      directoryReferences: command.content.directoryReferences ?? [],
      quotes: command.content.quotes ?? [],
      inlineReferences: (command.content.inlineReferences ?? []).map((reference) => ({
        ...reference, start: reference.start + prefix.length,
      })),
    };
  }

  reconcile(target: DesktopSessionLocalTarget, sessionId: string, messageId: string): void {
    const record = this.store.get(target.partition, messageId);
    if (!record || record.sessionId !== sessionId) throw new Error('Local message not found');
    if (record.state === 'failed')
      throw new Error('The Host refused this intent; edit and send a new message');
    this.#probed.delete(`${target.partition}:${messageId}`);
    this.wake();
  }

  readTranscript(
    target: DesktopSessionLocalTarget,
    sessionId: string,
  ): DesktopCachedTranscript | null {
    const cached = this.store.transcript(target.partition, sessionId);
    if (!cached) return null;
    return {
      cachedAt: cached.cachedAt,
      batches: [
        ...encodeDesktopTranscriptSnapshot({
          ...cached.snapshot,
          generation: `cached:${randomUUID()}`,
        }),
      ],
    };
  }

  catalog(): {
    scope: DesktopTargetScope;
    sessions: DesktopSessionSummaryInput[];
    authoritative: boolean;
  }[] {
    return this.deps
      .targets()
      .filter((target) => !this.#revoked.has(target.partition))
      .map((target) => {
        const fresh = this.#catalogFresh.get(target.partition);
        const authoritative = !!target.client && fresh?.epoch === target.client.hostEpoch;
        const sessions = this.store
          .sessions(target.partition)
          .map((session) =>
            this.store.creation(target.partition, session.id)
              ? { ...session, localState: 'pending' as const }
              : authoritative
                ? session
                : { ...session, runningTurnIds: undefined, localState: 'cached' as const },
          );
        if (
          target.client &&
          (!fresh || fresh.epoch !== target.client.hostEpoch || Date.now() - fresh.at > 5000)
        )
          this.#refreshCatalog(target);
        return { scope: target.scope, sessions, authoritative };
      });
  }

  #refreshCatalog(target: DesktopSessionLocalTarget): void {
    if (
      !target.client ||
      this.#catalogTasks.has(target.partition) ||
      this.#catalogTasks.size >= 2 ||
      this.#closed
    )
      return;
    const client = target.client;
    const revision = this.store.revision;
    const task = client
      .listSessions()
      .then((sessions) => {
        if (!this.#current(target)) return;
        // A late catalog cannot erase a Session created/removed while it read.
        if (this.store.revision !== revision) return;
        this.store.saveCatalog(target.partition, sessions.map(toDesktopHostSessionSummary));
        this.#catalogFresh.set(target.partition, { epoch: client.hostEpoch, at: Date.now() });
        this.deps.changed(target.scope);
      })
      .catch((error: unknown) => {
        if (!this.#current(target)) return;
        if (error instanceof RuntimeHostOperationError && error.code === 'unauthorized')
          this.purge(target, true);
        else this.deps.onError(error);
      })
      .finally(() => {
        this.#catalogTasks.delete(target.partition);
        if (
          this.#current(target) &&
          !this.#catalogFresh.has(target.partition) &&
          this.store.revision !== revision
        )
          this.deps.changed(target.scope);
      });
    this.#catalogTasks.set(target.partition, task);
  }

  purge(target: DesktopSessionLocalTarget, revoked = false): void {
    // Manager shutdown also removes its in-memory target generations. That
    // is not the user removing an authority or cancelling durable intentions.
    if (this.#closed) return;
    if (revoked) this.#revoked.add(target.partition);
    for (const [key, entry] of this.#snapshots)
      if (entry.target.partition === target.partition) this.#snapshots.delete(key);
    this.store.purge(target.partition);
    this.#catalogFresh.delete(target.partition);
    this.deps.changed(target.scope);
  }

  cacheTranscript(scope: DesktopTargetScope, snapshot: DesktopTranscriptReplicaSnapshot): void {
    if (this.#closed) return;
    let target: DesktopSessionLocalTarget;
    try {
      target = this.target(scope);
    } catch {
      return;
    }
    // Delivery completion depends on durable Host evidence, never on optional
    // cache admission/coalescing. Evidence can arrive before the submit ACK;
    // removing the intent also fences that worker's late completion.
    try {
      if (this.store.retireObservedMessages(target.partition, snapshot)) {
        this.deps.changed(target.scope, snapshot.sessionId);
        this.wake();
      }
    } catch (error) {
      this.deps.onError(error);
    }
    const key = `${target.partition}:${snapshot.sessionId}`;
    const pending = this.#snapshots.has(key);
    this.#snapshots.set(key, { target, snapshot });
    if (pending) return;
    const revision = this.store.revision;
    setImmediate(() => {
      const latest = this.#snapshots.get(key);
      this.#snapshots.delete(key);
      if (!latest || !this.#current(latest.target) || revision !== this.store.revision) return;
      try {
        this.store.saveTranscript(latest.target.partition, latest.snapshot);
      } catch (error) {
        this.deps.onError(error);
      }
    });
  }

  retireRetractedMessages(
    scope: DesktopTargetScope, hostEpoch: string, sessionId: string, messageIds: readonly string[],
  ): void {
    if (this.#closed) return;
    let target: DesktopSessionLocalTarget;
    try { target = this.target(scope); } catch { return; }
    if (this.store.retireRetractedMessages(target.partition, hostEpoch, sessionId, messageIds)) {
      this.deps.changed(target.scope, sessionId);
      this.wake();
    }
  }

  retireCancelledMessages(scope: DesktopTargetScope, sessionId: string, messageIds: readonly string[]): void {
    if (this.#closed) return;
    let target: DesktopSessionLocalTarget;
    try { target = this.target(scope); } catch { return; }
    if (this.store.retireCancelledMessages(target.partition, sessionId, messageIds)) {
      this.deps.changed(target.scope, sessionId);
      this.wake();
    }
  }

  close(): void {
    this.#closed = true;
    this.#snapshots.clear();
    for (const timer of this.#retries.values()) clearTimeout(timer);
    this.#retries.clear();
    this.#probed.clear();
    this.#checking.clear();
  }

  #current(target: DesktopSessionLocalTarget): boolean {
    return (
      !this.#closed &&
      !this.#revoked.has(target.partition) &&
      this.deps
        .targets()
        .some(
          (current) => current.partition === target.partition && current.client === target.client,
        )
    );
  }

  async #deliver(target: DesktopSessionLocalTarget, original: LocalOutboxRecord): Promise<void> {
    const client = target.client!;
    let record = original;
    const key = `${target.partition}:${record.messageId}`;
    if (original.state === 'unknown') this.#checking.add(key);
    this.#probed.set(key, client);
    const stillOwned = () =>
      this.#current(target) && this.store.get(record.partition, record.messageId) !== undefined;
    try {
      const creation = this.store.creation(target.partition, record.sessionId);
      if (creation) {
        // session.create already has a durable request fingerprint. Replaying
        // exactly this create cannot adopt somebody else's Session identity.
        const session = await client.createSession(creation);
        if (!stillOwned()) return;
        this.store.saveSession(target.partition, toDesktopHostSessionSummary(session));
      }
      if (!record.intent.attachmentsPrepared) {
        const attachments = [...(record.intent.command.content.attachments ?? [])];
        for (const [ordinal, staged] of this.store
          .stagedAttachments(record.partition, record.messageId)
          .entries()) {
          const uploadId = createHash('sha256')
            .update(JSON.stringify([record.partition, record.messageId, ordinal]))
            .digest('hex');
          attachments.push(
            await client.ingestAttachment({ sessionId: record.sessionId, uploadId, ...staged }),
          );
          if (!stillOwned()) return;
        }
        record = {
          ...record,
          intent: {
            ...record.intent,
            attachmentsPrepared: true,
            command: {
              ...record.intent.command,
              content: { ...record.intent.command.content, attachments },
            },
          },
        };
        this.store.update(record);
      }
      if (!stillOwned()) return;
      record = {
        ...record,
        state: original.state === 'unknown' ? 'unknown' : 'sending',
        intent: {
          ...record.intent,
          originHostEpoch: record.intent.originHostEpoch ?? client.hostEpoch,
        },
      };
      this.store.update(record);
      this.deps.changed(target.scope, record.sessionId);
      const result = await target.submit!({
        ...record.intent.command,
        originHostEpoch: record.intent.originHostEpoch!,
      });
      if (!stillOwned()) return;
      record = {
        ...record,
        state: result.disposition === 'blocked' ? 'failed' : 'accepted',
        result,
        ...(result.disposition === 'blocked'
          ? { error: 'Host refused the requested skill invocation. Edit and send a new message.' }
          : { error: undefined }),
      };
      this.store.update(record);
      this.#probed.delete(key);
      this.#catalogFresh.delete(target.partition);
    } catch (error) {
      if (!stillOwned()) return;
      if (error instanceof RuntimeHostOperationError && error.code === 'unauthorized') {
        this.purge(target, true);
        return;
      }
      const uncertain =
        record.intent.originHostEpoch !== undefined &&
        (error instanceof RuntimeHostRequestInterruptedError ||
          !(error instanceof RuntimeHostOperationError) ||
          error.code === 'outcome_unknown');
      const retryable =
        error instanceof RuntimeHostRequestInterruptedError ||
        (error instanceof RuntimeHostOperationError &&
          ['host_not_ready', 'host_draining', 'persistence_failed'].includes(error.code));
      this.store.update({
        ...record,
        state: uncertain ? 'unknown' : retryable ? 'saved' : 'failed',
        error: uncertain
          ? 'Host outcome is unknown; checking the original message cannot start a duplicate execution.'
          : retryable
            ? 'Saved locally. Waiting for the Host to become available.'
            : error instanceof RuntimeHostOperationError
              ? `Host refused the message (${error.code}).`
              : 'Message preparation failed. The local copy is retained.',
      });
      if ((uncertain || retryable) && !this.#closed && !this.#retries.has(key)) {
        const timer = setTimeout(() => {
          this.#retries.delete(key);
          this.#probed.delete(key);
          this.wake();
        }, 5000);
        timer.unref();
        this.#retries.set(key, timer);
      } else if (!uncertain && !retryable) this.#probed.delete(key);
    }
    this.#checking.delete(key);
    this.deps.changed(target.scope, record.sessionId);
  }
}

export function registerDesktopSessionLocalIpc(deps: {
  ipcMain: Pick<IpcMain, 'handle'>;
  service: DesktopSessionLocalService;
  approvals: AttachmentApprovalRegistry;
  resizeImage(bytes: Uint8Array): Promise<Uint8Array>;
  resolveWorkspace(
    target: DesktopSessionLocalTarget,
    input: CreateSessionRequestInput,
  ): Promise<WorkspaceTarget>;
  changed(scope: DesktopTargetScope, sessionId: string): void;
}): void {
  const { ipcMain, service } = deps;
  ipcMain.handle('session-local:catalog', () => service.catalog());
  ipcMain.handle('session-local:messages', (_event, scope: unknown, sessionId: string) =>
    service.listMessages(service.target(scope), requiredId(sessionId)),
  );
  ipcMain.handle('session-local:edit', (_event, scope: unknown, sessionId: string, messageId: string) =>
    service.readFailedMessage(service.target(scope), requiredId(sessionId), requiredId(messageId)),
  );
  ipcMain.handle('session-local:transcript', (_event, scope: unknown, sessionId: string) =>
    service.readTranscript(service.target(scope), requiredId(sessionId)),
  );
  ipcMain.handle(
    'session-local:cancel',
    (_event, scope: unknown, sessionId: string, messageId: string) => {
      const target = service.target(scope);
      const record = service.store.get(target.partition, requiredId(messageId));
      if (record && record.sessionId !== sessionId)
        throw new Error('Message belongs to another Session');
      service.store.cancel(target.partition, messageId);
      deps.changed(target.scope, sessionId);
      service.wake();
    },
  );
  ipcMain.handle(
    'session-local:reconcile',
    (_event, scope: unknown, sessionId: string, messageId: string) =>
      service.reconcile(service.target(scope), requiredId(sessionId), requiredId(messageId)),
  );
  ipcMain.handle(
    'session-local:create',
    async (_event, scope: unknown, input: CreateSessionRequestInput = {}) => {
      const target = service.target(scope);
      const workspace =
        typeof input.projectId === 'string'
          ? { kind: 'project' as const, projectId: input.projectId }
          : await deps.resolveWorkspace(target, input);
      const creation = resolveDesktopSessionCreateInput(input, randomUUID(), workspace);
      const summary: DesktopSessionSummaryInput = {
        id: creation.sessionId,
        revision: 0,
        localState: 'pending',
        name: creation.name ?? 'New task',
        localCreatedAt: Date.now(),
        ...(workspace.kind === 'project'
          ? { projectId: workspace.projectId }
          : { cwd: workspace.path }),
        isFlagged: false,
        isArchived: false,
        labels: [...(creation.labels ?? [])],
        hasUnread: false,
        status: 'active',
        backend: 'ai-sdk',
        llmConnectionSlug: input.llmConnectionSlug ?? '',
        model: input.model ?? '',
        ...(input.llmConnectionId ? { llmConnectionId: input.llmConnectionId } : {}),
        connectionLocked: false,
        permissionMode: creation.permissionMode ?? 'ask',
        collaborationMode: creation.collaborationMode,
        orchestrationMode: creation.orchestrationMode,
        thinkingLevel: creation.thinkingLevel,
      };
      service.store.saveSession(target.partition, summary, creation);
      deps.changed(target.scope, creation.sessionId);
      return summary;
    },
  );
  ipcMain.handle('session-local:discard', (_event, scope: unknown, sessionId: string) => {
    const target = service.target(scope);
    if (!service.store.creation(target.partition, sessionId)) return false;
    if (
      service.store
        .list(target.partition, sessionId)
        .some((record) => record.intent.originHostEpoch)
    )
      throw new Error('Session has a dispatched message');
    service.store.removeSession(target.partition, sessionId);
    deps.changed(target.scope, sessionId);
    return true;
  });
  ipcMain.handle(
    'session-local:submit',
    async (event, scope: unknown, sessionId: string, placement: unknown, value: unknown) => {
      const target = service.target(scope);
      requiredId(sessionId);
      if (placement !== 'current_turn' && placement !== 'next_turn')
        throw new Error('Invalid message placement');
      const command = normalizeSessionSendCommand({
        ...(value && typeof value === 'object' ? value : {}),
        type: 'send',
      });
      if (!command?.messageId) throw new Error('Invalid submitted message');
      const messageId = command.messageId;
      if (command.directoryReferences?.some((ref) => ref.hostId !== target.scope.hostId))
        throw new Error('Directory reference belongs to another Host');
      const retained = command.retainedAttachments ?? [];
      for (const attachment of retained) {
        if (attachment.ref.kind !== 'session_file' || attachment.ref.sessionId !== sessionId)
          throw new Error('Retained attachment belongs to another Session');
      }
      const prepared = await prepareIngestItems({
        senderId: event.sender.id,
        items: command.attachmentItems ?? [],
        approvals: deps.approvals,
        stat,
        maxAttachments: MAX_ATTACHMENT_COUNT - retained.length,
        maxTotalBytes: MAX_LOCAL_MESSAGE_BYTES,
      });
      const staged = await resolveAttachmentRefs({
        files: prepared.files,
        maxTotalBytes: MAX_LOCAL_MESSAGE_BYTES,
        resizeImage: deps.resizeImage,
        snapshot: async ({ name, mimeType, content }) => ({
          name,
          mimeType,
          base64: Buffer.from(content).toString('base64'),
        }),
      });
      // Revalidate authority after asynchronous file reads and native resizing.
      if (service.target(scope).partition !== target.partition)
        throw new Error('Host authority changed while saving the message');
      const displayText = command.displayText ?? command.text;
      const inlineReferences = mergeWorkspaceFileInlineReferences({
        displayText,
        workspaceFileReferences: command.workspaceFileReferences,
      });
      prepared.commit(() =>
        service.store.enqueue(target.partition, {
          staged,
          command: {
            sessionId,
            messageId,
            placement,
            content: {
              text: command.text,
              ...(command.displayText !== undefined ? { displayText } : {}),
              attachments: retained,
              directoryReferences: command.directoryReferences,
              quotes: command.quotes,
              inlineReferences,
            },
            ...(command.skillIds?.length ? { skillIds: command.skillIds } : {}),
            ...(command.turnOrchestration ? { turnOrchestration: command.turnOrchestration } : {}),
          },
        }),
      );
      deps.changed(target.scope, sessionId);
      service.wake();
      return {
        ok: true,
        disposition: 'locally_saved',
        attachments: retained,
        inlineReferences,
        skillInvocation: { loaded: [], failed: [], receipts: [] },
      };
    },
  );
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256)
    throw new Error('Invalid local Session or Message identity');
  return value;
}
