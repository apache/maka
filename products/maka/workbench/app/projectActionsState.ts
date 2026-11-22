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

import { cleanup, effect, signal, untracked } from 'nsh';
import type { UiContext } from '../../../../packages/plugin-sdk/src/workbench';
import type { ClientOperation } from '../../../../packages/plugin-sdk/src/index';
import type { Host, Input, Output, Method } from './host';
import { completed } from './terminalState';
import { createPendingRecovery } from './pendingRecovery';
import { createText, errorText, message } from './text';
import { invalidate, subscribe } from './uiSync';

type Success<T> = T extends { kind: 'completed'; value: infer V } ? V : never;
export type ActionDefinition = Success<Output<'projectActions', 'definitions'>>[number];
type ActionDirectory = { projectId: string; path: string };
type ActionSelection =
  | ({ kind: 'project' } & ActionDirectory)
  | { kind: 'workspace'; path: string };

function originalProject({ endpoint, correlation }: ClientOperation): string | null {
  return endpoint === 'projectActions' &&
    correlation !== null &&
    typeof correlation === 'object' &&
    'projectId' in correlation &&
    typeof correlation.projectId === 'string' &&
    correlation.projectId.length > 0
    ? correlation.projectId
    : null;
}

export function createProjectActions(
  context: UiContext,
  host: Host,
  selection: () => ActionSelection | null,
  launch?: (definition: ActionDefinition) => Promise<void>,
) {
  const directory = signal<ActionDirectory | null>(null);
  const workspaceLookupFailed = signal(false);
  const definitions = signal<ActionDefinition[]>([]);
  const loading = signal(false);
  const definitionError = createText();
  const performing = signal(false);
  const recovering = signal(false);
  const busy = () => performing() || recovering();
  const pending = signal<ClientOperation[]>([]);
  const known = signal(false);
  const error = createText();
  const journalError = createText();
  let alive = true;
  let generation = 0;
  let pendingCompletion: { id: string; complete(): void } | null = null;
  const finishMutation = (id: string | undefined) => {
    if (!alive || !pendingCompletion || pendingCompletion.id !== id) return;
    const { complete } = pendingCompletion;
    pendingCompletion = null;
    complete();
  };
  let definitionsRequest = 0;
  let journalRetryDelayMs = 2000;
  const selectionVersion = signal(0);
  const idle = () => alive && !busy() && !loading();
  const ready = () => idle() && directory() !== null && known() && pending().length === 0;
  const report = (reason: unknown) => {
    if (alive) error.set(errorText(reason, 'Could not complete the Action command.'));
  };
  const refreshPending = async () => {
    const current = generation;
    const projectId = directory()?.projectId;
    try {
      const entries = await context.operations.pending();
      if (!alive || current !== generation) return null;
      const operations = entries.filter((item) => {
        if (item.endpoint !== 'projectActions')
          return item.endpoint === 'agent' && item.method === 'project';
        const owner = originalProject(item);
        return owner === null || owner === projectId;
      });
      journalRetryDelayMs = 2000;
      pending.set(operations);
      known.set(true);
      journalError.set('');
      return operations;
    } catch (reason) {
      if (alive && current === generation) {
        if (journalError()) journalRetryDelayMs = Math.min(journalRetryDelayMs * 2, 30000);
        const fallback = 'Could not read the local Action operation log.';
        known.set(false);
        journalError.set(errorText(reason, fallback) || message(fallback));
      }
      return null;
    }
  };
  const mutate = async <M extends Method<'projectActions', 'mutation'>>(
    method: M,
    input: Input<'projectActions', M>,
    started?: (operationId: string) => void,
  ): Promise<Output<'projectActions', M>> => {
    try {
      return await host.projectActionMutation(method, input, started);
    } finally {
      if (alive && directory()?.projectId === input.projectId) await refreshPending();
    }
  };
  const perform = async <T>(operation: () => Promise<T>) => {
    if (!ready()) return;
    performing.set(true);
    error.set('');
    try {
      return await operation();
    } catch (reason) {
      report(reason);
    } finally {
      if (alive) performing.set(false);
    }
  };
  const performMutation = <T>(
    onCompleted: (() => void) | undefined,
    operation: (started: (id: string) => void) => Promise<T>,
  ) =>
    perform(async () => {
      const current = generation;
      let operationId: string | undefined;
      pendingCompletion = null;
      const result = await operation((id) => {
        operationId = id;
        if (alive && current === generation && onCompleted)
          pendingCompletion = { id, complete: onCompleted };
      });
      finishMutation(operationId);
      return result;
    });
  const loadDefinitions = async () => {
    const owner = directory();
    if (!alive || !owner) return;
    const current = ++definitionsRequest;
    try {
      const rows = completed(
        await host.query('projectActions', 'definitions', { projectId: owner.projectId }),
      );
      if (alive && directory() === owner && current === definitionsRequest) {
        definitions.set(rows);
        definitionError.set('');
      }
    } catch (reason) {
      if (alive && directory() === owner && current === definitionsRequest)
        definitionError.set(errorText(reason, 'Could not load Project Actions.'));
    }
  };
  const resolveWorkspace = async (path: string): Promise<ActionDirectory | null> => {
    const lookup = await host.query('agent', 'projects', { kind: 'directory', path });
    if (lookup.kind !== 'directory') return null;
    const project = lookup.location.project;
    return project && !project.archived ? { projectId: project.reference.id, path } : null;
  };
  const loadSelection = async (selected: ActionSelection, current: number) => {
    loading.set(true);
    try {
      const owner =
        selected.kind === 'project'
          ? { projectId: selected.projectId, path: selected.path }
          : await resolveWorkspace(selected.path);
      if (!alive || current !== generation) return;
      if (workspaceLookupFailed()) error.set('');
      workspaceLookupFailed.set(false);
      if (!owner) return;
      directory.set(owner);
      void refreshPending();
      await loadDefinitions();
    } catch (reason) {
      if (alive && current === generation) {
        report(reason);
        if (selected.kind === 'workspace' && !directory()) workspaceLookupFailed.set(true);
      }
    } finally {
      if (alive && current === generation) loading.set(false);
    }
  };
  const retryWorkspace = async () => {
    if (!idle() || !workspaceLookupFailed()) return;
    const selected = selection();
    if (selected?.kind === 'workspace') await loadSelection(selected, generation);
  };
  const definitionsChanged = (projectId: string | null) => {
    const owner = directory();
    if (!owner) void retryWorkspace();
    else if (projectId === null || owner.projectId === projectId) void loadDefinitions();
  };
  const unsubscribeDefinitions = subscribe('actionDefinitions', definitionsChanged);
  const recover = async () => {
    if (!idle()) return;
    const current = generation;
    recovering.set(true);
    try {
      const originals = await refreshPending();
      if (!originals || current !== generation) return;
      error.set('');
      try {
        for (const original of originals) {
          if (!alive || current !== generation) break;
          const reply = await context.operations.recover(original.id);
          if (reply.receipt.kind !== 'recorded' || reply.receipt.outcome.kind !== 'returned')
            continue;
          const result = reply.receipt.outcome.result;
          if (result.kind === 'failure') throw new Error(result.diagnostic);
          const origin = current === generation ? definitionsChanged : undefined;
          if (
            original.endpoint === 'projectActions' &&
            (original.method === 'create' || original.method === 'update')
          ) {
            const definition = completed(
              result.value as Output<'projectActions', 'create' | 'update'>,
            );
            invalidate('actionDefinitions', definition.projectId, origin);
            if (current === generation) finishMutation(original.id);
          } else if (original.endpoint === 'projectActions' && original.method === 'remove') {
            completed(result.value as Output<'projectActions', 'remove'>);
            invalidate('actionDefinitions', originalProject(original), origin);
            if (current === generation) finishMutation(original.id);
          }
        }
      } finally {
        if (alive && current === generation) {
          await Promise.all([loadDefinitions(), originals.length && refreshPending()]);
        }
      }
      if (!alive || current !== generation || !known()) return;
      if (selection() && !directory() && !pending().length)
        selectionVersion.set(selectionVersion() + 1);
    } catch (reason) {
      if (current === generation) report(reason);
    } finally {
      if (alive && current === generation) recovering.set(false);
    }
  };
  effect(() => {
    const selected = selection();
    selectionVersion();
    untracked(() => {
      const current = ++generation;
      pendingCompletion = null;
      directory.set(null);
      workspaceLookupFailed.set(false);
      recovering.set(false);
      definitions.set([]);
      definitionError.set('');
      pending.set(pending().filter((item) => originalProject(item) === null));
      known.set(false);
      journalError.set('');
      error.set('');
      if (!selected) {
        loading.set(false);
        return;
      }
      void loadSelection(selected, current);
    });
  });
  createPendingRecovery({
    pending: () =>
      workspaceLookupFailed() || pending().length > 0 || (directory() !== null && !known()),
    blocked: () => !idle(),
    recover: () => (workspaceLookupFailed() ? retryWorkspace() : recover()),
    retryDelayMs: () => journalRetryDelayMs,
  });
  cleanup(() => {
    alive = false;
    generation++;
    pendingCompletion = null;
    unsubscribeDefinitions();
  });
  const refresh = () => perform(loadDefinitions);
  const problem = () => {
    const retry =
      journalError() || pending().length
        ? {
            label: message(known() ? 'Check original Action operation' : 'Retry'),
            run: recover,
          }
        : definitionError()
          ? { label: message('Retry'), run: refresh }
          : null;
    return {
      message: journalError() || error() || definitionError(),
      retry: retry && { ...retry, enabled: idle() },
    };
  };
  return {
    directory,
    definitions,
    loading,
    ready,
    performing,
    empty: () => known() && !definitionError() && definitions().length === 0,
    problem,
    dismissError: () => error.set(''),
    refresh,
    recover,
    async activate(definition: ActionDefinition) {
      if (!ready() || !launch) return;
      const current = generation;
      error.set('');
      try {
        await launch(definition);
      } catch (reason) {
        if (current === generation) report(reason);
      }
    },
    save: (
      original: ActionDefinition | null,
      name: string,
      command: string,
      onSaved?: () => void,
    ) =>
      performMutation(onSaved, async (started) => {
        const owner = directory();
        if (!owner) return;
        const saved = completed(
          original
            ? await mutate(
                'update',
                {
                  projectId: owner.projectId,
                  id: original.id,
                  revision: original.revision,
                  name,
                  command,
                },
                started,
              )
            : await mutate('create', { projectId: owner.projectId, name, command }, started),
        );
        if (alive && directory()?.projectId === owner.projectId)
          definitions.set(
            [...definitions().filter((row) => row.id !== saved.id), saved].sort((a, b) =>
              a.id.localeCompare(b.id),
            ),
          );
        invalidate('actionDefinitions', owner.projectId, definitionsChanged);
        if (directory()?.projectId === owner.projectId) await loadDefinitions();
        return saved;
      }),
    remove: (original: ActionDefinition, onRemoved?: () => void) =>
      performMutation(onRemoved, async (started) => {
        const projectId = original.projectId;
        completed(
          await mutate(
            'remove',
            { projectId, id: original.id, revision: original.revision },
            started,
          ),
        );
        if (alive && directory()?.projectId === projectId)
          definitions.set(definitions().filter((row) => row.id !== original.id));
        invalidate('actionDefinitions', projectId, definitionsChanged);
        if (directory()?.projectId === projectId) await loadDefinitions();
        return true;
      }),
  };
}
export type ProjectActionsModel = ReturnType<typeof createProjectActions>;
