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

import { randomUUID } from 'node:crypto';
import type { IpcMain, WebContents } from 'electron';
import type {
  SessionWindowCommand, SessionWindowCommandReply, SessionWindowCommandResult,
  SessionWindowDraft, SessionWindowGroup, SessionWindowNavigation, SessionWindowOwnership,
} from '../shared/session-window-contract.js';
import type { MainWindowController } from './main-window.js';
import type { WorkspaceWindowEntry } from './workspace-window-registry.js';

type CommandInput = SessionWindowCommand extends infer Command
  ? Command extends SessionWindowCommand ? Omit<Command, 'requestId'> : never : never;

export interface SessionWindowCoordinatorDeps {
  readonly windows: MainWindowController;
  readonly signal: AbortSignal;
  readonly ensureMainWindow: () => Promise<void>;
  readonly resolveGroup: (sessionId: string) => Promise<SessionWindowGroup>;
  readonly knownGroups: () => readonly SessionWindowGroup[];
  readonly confirmClose: (sender: WebContents) => Promise<boolean>;
  readonly transferResources: (input: { group: SessionWindowGroup; source: WebContents | undefined; target: WebContents }) => void | Promise<void>;
  readonly releaseResources: (sender: WebContents) => void | Promise<void>;
  readonly isQuitting: () => boolean;
  readonly onError: (error: unknown, sender?: WebContents) => void;
  readonly commandTimeoutMs?: number;
}

/** Main owns session families. Renderers receive only their current navigation membership. */
export function createSessionWindowCoordinator(deps: SessionWindowCoordinatorDeps) {
  const registry = deps.windows.registry;
  const groups = new Map<string, SessionWindowGroup>();
  const memberGroups = new Map<string, string>();
  const owners = new Map<string, string>();
  const transferring = new Set<string>();
  const ready = new Map<string, object>();
  const readyWaiters = new Map<string, Set<(error?: Error) => void>>();
  const pending = new Map<string, { windowId: string; resolve(result: SessionWindowCommandResult): void; reject(error: Error): void }>();
  const closing = new Set<string>();
  const finalized = new Set<string>();
  let operations: Promise<unknown> = Promise.resolve();
  let version = 0;
  const timeoutMs = deps.commandTimeoutMs ?? 20_000;
  const keyOf = (group: SessionWindowGroup) => JSON.stringify([group.hostId, group.groupId]);
  const report = (error: unknown, sender?: WebContents) => deps.onError(error, sender);

  function requireWindow(sender: WebContents): WorkspaceWindowEntry {
    const entry = registry.forSender(sender);
    if (!entry) throw new Error('This operation requires a workspace window');
    return entry;
  }
  function assertOpen(entry: WorkspaceWindowEntry): void {
    if (entry.window.isDestroyed() || closing.has(entry.context.windowId)) throw new Error('The workspace window is closing');
  }
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = operations.catch(() => undefined).then(operation);
    operations = next;
    return next;
  }
  function membership(entry: WorkspaceWindowEntry): SessionWindowOwnership {
    const sessionIds = new Set<string>();
    for (const [key, group] of groups) {
      const owner = owners.get(key);
      if (owner === entry.context.windowId || (!owner && entry.context.kind === 'main')) {
        for (const id of group.sessionIds) sessionIds.add(id);
      }
    }
    return { version, sessionIds: [...sessionIds] };
  }
  function publish(): void {
    version += 1;
    for (const entry of registry.entries()) entry.window.webContents.send('session-window:ownership', membership(entry));
  }
  function remember(resolved: SessionWindowGroup): SessionWindowGroup {
    const keys = resolved.sessionIds.flatMap((id) => memberGroups.has(id) ? [memberGroups.get(id)!] : []);
    const key = keys.find((id) => owners.has(id)) ?? keyOf(resolved);
    if (keys.some((id) => id !== key && owners.has(id))) throw new Error('Related sessions belong to different windows');
    const previous = groups.get(key);
    const group = { ...resolved, groupId: previous?.groupId ?? resolved.groupId,
      sessionIds: [...new Set([...(previous?.sessionIds ?? []), ...resolved.sessionIds])] };
    for (const old of new Set(keys)) if (old !== key) groups.delete(old);
    groups.set(key, group);
    for (const id of group.sessionIds) memberGroups.set(id, key);
    return group;
  }
  function refreshOwnership(): void {
    for (const group of deps.knownGroups()) remember(group);
    publish();
  }
  async function resolveGroup(id: string): Promise<SessionWindowGroup> {
    const group = remember(await deps.resolveGroup(id));
    publish();
    return group;
  }
  function owner(group: SessionWindowGroup): WorkspaceWindowEntry | undefined {
    const id = owners.get(keyOf(group));
    return id ? registry.get(id) : undefined;
  }
  function rejectRequests(windowId: string): void {
    ready.delete(windowId);
    for (const complete of readyWaiters.get(windowId) ?? []) complete(new Error('The workspace window closed'));
    readyWaiters.delete(windowId);
    for (const operation of pending.values()) if (operation.windowId === windowId) operation.reject(new Error('The workspace window closed'));
  }
  async function waitReady(entry: WorkspaceWindowEntry): Promise<void> {
    if (entry.window.isDestroyed()) throw new Error('The workspace window is unavailable');
    const id = entry.context.windowId;
    if (ready.has(id)) return;
    await new Promise<void>((resolve, reject) => {
      const waiters = readyWaiters.get(id) ?? new Set<(error?: Error) => void>();
      const complete = (error?: Error) => { clearTimeout(timer); waiters.delete(complete); if (error) reject(error); else resolve(); };
      const timer = setTimeout(() => complete(new Error('The workspace window did not become ready')), timeoutMs);
      readyWaiters.set(id, waiters);
      waiters.add(complete);
    });
  }
  async function request(entry: WorkspaceWindowEntry, input: CommandInput): Promise<SessionWindowCommandResult> {
    await waitReady(entry);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const complete = (error?: Error, result?: SessionWindowCommandResult) => {
        clearTimeout(timer); pending.delete(requestId);
        if (error) reject(error); else resolve(result ?? {});
      };
      const timer = setTimeout(() => complete(new Error(`Workspace ${input.kind} was not confirmed`)), timeoutMs);
      pending.set(requestId, { windowId: entry.context.windowId, resolve: (result) => complete(undefined, result), reject: complete });
      try { entry.window.webContents.send('session-window:command', { ...input, requestId }); }
      catch (error) { complete(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  async function ensureMain(): Promise<WorkspaceWindowEntry> {
    await deps.ensureMainWindow();
    const entry = registry.main();
    if (!entry) throw new Error('The main window is unavailable');
    assertOpen(entry);
    await waitReady(entry);
    return entry;
  }
  async function navigate(entry: WorkspaceWindowEntry, navigation: SessionWindowNavigation): Promise<void> {
    assertOpen(entry);
    await request(entry, { kind: 'navigate', navigation });
    entry.controller.reveal();
    entry.controller.focus();
  }
  async function transfer(group: SessionWindowGroup, initial: string, target: WorkspaceWindowEntry, source?: WorkspaceWindowEntry): Promise<void> {
    assertOpen(target);
    if (source) assertOpen(source);
    const key = keyOf(group);
    const transferId = randomUUID();
    const targetSender = target.window.webContents;
    const sourceSender = source?.window.webContents;
    transferring.add(key);
    let movedResources = false;
    try {
      await waitReady(target);
      const receivingDocument = ready.get(target.context.windowId);
      if (!receivingDocument) throw new Error('The receiving renderer is unavailable');
      const captured = source ? await request(source, { kind: 'prepare', transferId, group }) : { drafts: [] };
      const drafts = requireDrafts(captured.drafts, group);
      const sessionId = source?.context.kind === 'session' && captured.activeSessionId && group.sessionIds.includes(captured.activeSessionId)
        ? captured.activeSessionId : initial;
      // Receiving only stages the drafts. Ownership publication activates the
      // target after receipt; until then the source keeps its original drafts.
      await request(target, { kind: 'receive', transferId, group, navigation: { sessionId }, drafts });
      movedResources = true;
      await deps.transferResources({ group, source: sourceSender, target: targetSender });
      assertOpen(target);
      if (ready.get(target.context.windowId) !== receivingDocument) throw new Error('The receiving renderer changed during handoff');
      if (target.context.kind === 'session') owners.set(key, target.context.windowId);
      else owners.delete(key);
    } catch (error) {
      // A staged target is never active before ownership commits. Do not destroy
      // Main or snapshot its unrelated conversation when returning a child fails.
      await request(target, { kind: 'abort', transferId }).catch((failure) => report(failure, targetSender));
      if (source && !source.window.isDestroyed()) {
        if (movedResources) await Promise.resolve().then(() => deps.transferResources({ group, source: targetSender, target: sourceSender! })).catch((failure) => report(failure, sourceSender));
        await request(source, { kind: 'abort', transferId }).catch((failure) => report(failure, sourceSender));
      }
      throw error;
    } finally { transferring.delete(key); }
    publish();
    target.controller.reveal();
    target.controller.focus();
    if (source?.context.kind === 'session' && !source.window.isDestroyed()) source.window.destroy();
  }
  function attach(entry: WorkspaceWindowEntry): void {
    const id = entry.context.windowId;
    const sender = entry.window.webContents;
    sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) rejectRequests(id); });
    sender.on('render-process-gone', () => {
      rejectRequests(id);
      void Promise.resolve().then(() => deps.releaseResources(sender)).catch((error) => report(error, sender));
    });
    entry.window.once('closed', () => {
      rejectRequests(id);
      void Promise.resolve().then(() => deps.releaseResources(sender)).catch((error) => report(error, sender));
      for (const [key, ownerId] of owners) if (ownerId === id) owners.delete(key);
      finalized.delete(id);
      publish();
    });
    entry.window.on('close', (event) => {
      if (deps.isQuitting() || finalized.has(id)) return;
      event.preventDefault();
      if (closing.has(id)) return;
      closing.add(id);
      void serial(async () => {
        if (entry.window.isDestroyed()) return;
        if (entry.context.kind === 'session') {
          let unsent = true;
          try {
            const group = await resolveGroup(entry.context.initialSessionId);
            unsent = (await request(entry, { kind: 'check-close', group })).hasUnsent !== false;
          } catch (error) { report(error, sender); }
          if (unsent && !await deps.confirmClose(sender)) {
            await request(entry, { kind: 'cancel-close' });
            return;
          }
        }
        finalized.add(id);
        entry.window.close();
      }).catch(async (error) => {
        await request(entry, { kind: 'cancel-close' }).catch(() => undefined);
        report(error, sender);
      }).finally(() => closing.delete(id));
    });
  }
  for (const entry of registry.entries()) attach(entry);
  const unsubscribe = registry.onRegistered(attach);

  function ownerForSession(sessionId: string): WebContents | undefined {
    const key = memberGroups.get(sessionId);
    const id = key && owners.get(key);
    return id ? registry.get(id)?.window.webContents : undefined;
  }
  return {
    context: (sender: WebContents) => requireWindow(sender).context,
    ownership(sender: WebContents) { refreshOwnership(); return membership(requireWindow(sender)); },
    refreshOwnership,
    refreshGroup: resolveGroup,
    ownerForSession,
    canUseSession(sender: WebContents, sessionId: string): boolean {
      const entry = registry.forSender(sender);
      const key = memberGroups.get(sessionId);
      if (!entry || !key || transferring.has(key)) return false;
      const owner = ownerForSession(sessionId);
      return owner ? owner === sender : entry.context.kind === 'main';
    },
    routeSession(sender: WebContents, navigation: SessionWindowNavigation): Promise<void> {
      const origin = requireWindow(sender);
      return serial(async () => {
        assertOpen(origin);
        const group = await resolveGroup(navigation.sessionId);
        await navigate(owner(group) ?? await ensureMain(), navigation);
      });
    },
    openSessionWindow(sender: WebContents, sessionId: string): Promise<void> {
      const origin = requireWindow(sender);
      return serial(async () => {
        assertOpen(origin);
        const group = await resolveGroup(sessionId);
        const existing = owner(group);
        if (existing) { await navigate(existing, { sessionId }); return; }
        const source = registry.main();
        const controller = await deps.windows.createSessionWindow({ kind: 'session', group, initialSessionId: sessionId }, deps.signal);
        const window = controller.browserWindow();
        if (!window) throw new Error('The session window could not be created');
        try { await transfer(group, sessionId, requireWindow(window.webContents), source); }
        catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
      });
    },
    openInMainWindow(sender: WebContents): Promise<void> {
      const origin = requireWindow(sender);
      return serial(async () => {
        assertOpen(origin);
        if (origin.context.kind !== 'session') return;
        const group = await resolveGroup(origin.context.initialSessionId);
        if (owner(group) !== origin) throw new Error('This session belongs to another window');
        await transfer(group, origin.context.initialSessionId, await ensureMain(), origin);
      });
    },
    sessionWindowReady(sender: WebContents): void {
      const entry = requireWindow(sender);
      const id = entry.context.windowId;
      if (ready.has(id)) return;
      ready.set(id, {});
      for (const complete of readyWaiters.get(id) ?? []) complete();
      refreshOwnership();
      // A renderer reload keeps the native window's existing ownership, but
      // does not persist or reconstruct unsent drafts from another store.
      if (entry.context.kind === 'session' && ownerForSession(entry.context.initialSessionId) === sender) {
        void serial(() => navigate(entry, { sessionId: (entry.context as Extract<typeof entry.context, { kind: 'session' }>).initialSessionId })).catch((error) => report(error, sender));
      }
    },
    reply(sender: WebContents, reply: SessionWindowCommandReply): void {
      const operation = pending.get(reply.requestId);
      if (operation?.windowId !== requireWindow(sender).context.windowId) return;
      if (reply.ok) operation.resolve(reply.result ?? {}); else operation.reject(new Error(reply.error));
    },
    commandMain(sender: WebContents, command: 'newTask' | 'openSettings' | 'openHelp'): Promise<void> {
      const origin = requireWindow(sender);
      return serial(async () => {
        assertOpen(origin);
        const entry = await ensureMain();
        entry.window.webContents.send('window:command', { id: command });
        entry.controller.focus();
      });
    },
    dispose(): void {
      unsubscribe();
      for (const entry of registry.entries()) rejectRequests(entry.context.windowId);
    },
  };
}

function requireDrafts(value: readonly SessionWindowDraft[] | undefined, group: SessionWindowGroup): readonly SessionWindowDraft[] {
  if (!Array.isArray(value)) throw new Error('The source window did not confirm its drafts');
  const ids = new Set<string>();
  for (const draft of value) {
    if (!draft || typeof draft.text !== 'string' || !Array.isArray(draft.references) || !group.sessionIds.includes(draft.sessionId) || ids.has(draft.sessionId)) throw new Error('Invalid session draft');
    ids.add(draft.sessionId);
  }
  return value;
}
export type SessionWindowCoordinator = ReturnType<typeof createSessionWindowCoordinator>;
export function registerSessionWindowIpc(coordinator: SessionWindowCoordinator, ipc: Pick<IpcMain, 'handle'>): void {
  function handle(channel: string, action: (sender: WebContents, input: any) => unknown): void {
    ipc.handle(`session-window:${channel}`, (event, input: unknown) => {
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('Session windows require the main frame');
      coordinator.context(event.sender);
      return action(event.sender, input);
    });
  }
  handle('context', (sender) => coordinator.context(sender));
  handle('ownership', (sender) => coordinator.ownership(sender));
  handle('ready', (sender) => coordinator.sessionWindowReady(sender));
  handle('route', (sender, input: unknown) => coordinator.routeSession(sender, requireNavigation(input)));
  handle('open', (sender, input: unknown) => coordinator.openSessionWindow(sender, requireSessionId(input)));
  handle('open-main', (sender) => coordinator.openInMainWindow(sender));
  handle('reply', (sender, input: unknown) => {
    if (!input || typeof input !== 'object' || !('requestId' in input) || typeof input.requestId !== 'string' || !('ok' in input) || typeof input.ok !== 'boolean') throw new TypeError('Invalid window reply');
    if (!input.ok && (!('error' in input) || typeof input.error !== 'string')) throw new TypeError('Invalid window reply');
    return coordinator.reply(sender, input as SessionWindowCommandReply);
  });
  handle('command-main', (sender, input: unknown) => {
    if (input !== 'newTask' && input !== 'openSettings' && input !== 'openHelp') throw new TypeError('Invalid main window command');
    return coordinator.commandMain(sender, input);
  });
}
function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new TypeError('Invalid session identity');
  return value;
}
function requireNavigation(input: unknown): SessionWindowNavigation {
  if (!input || typeof input !== 'object' || !('sessionId' in input)) throw new TypeError('Invalid session navigation');
  const sessionId = requireSessionId(input.sessionId);
  if ('turnId' in input && input.turnId !== undefined && (typeof input.turnId !== 'string' || input.turnId.length > 4096)) throw new TypeError('Invalid turn identity');
  if ('sequence' in input && input.sequence !== undefined && (typeof input.sequence !== 'number' || !Number.isSafeInteger(input.sequence) || input.sequence < 0)) throw new TypeError('Invalid turn sequence');
  return { sessionId, ...('turnId' in input && input.turnId !== undefined ? { turnId: input.turnId as string } : {}), ...('sequence' in input && input.sequence !== undefined ? { sequence: input.sequence as number } : {}) };
}
