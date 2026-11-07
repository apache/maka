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

import { cleanup, signal } from 'nsh';
import type {
  AgentExternalAgents,
  AgentExternalRuntime,
  DeploymentRef,
  SettingChange,
  ManagementResultForDeploymentRef,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { Host } from './host';
import type { SettingsOperations } from './settingsOperations';
import { errorMessage, UiError } from './text';
import { tr } from './locale';
import { sameValue } from '../../../../plugins/shared/value';

type Target = {
  instance: AgentExternalAgents['target'];
  configured: boolean;
  runtimes: AgentExternalAgents['runtimes'];
};
type Basis = { source: DeploymentRef; target: Target };
export type ExternalAgentAction = { view: number };
export function createExternalAgentSettings(
  host: Host,
  operations: SettingsOperations,
  active: () => boolean,
  changed: () => void,
) {
  const basis = signal<Basis | null>(null);
  const catalog = signal<AgentExternalAgents | null>(null);
  const confirmation = signal<{
    basis: Basis;
    runtime: string;
    name: string;
    acknowledged: boolean;
  } | null>(null);
  const details = signal<string | null>(null);
  const failure = signal<string | null>(null);
  const loading = signal(false);
  let alive = true;
  const view = signal(0);
  let read = 0;
  cleanup(() => {
    alive = false;
    read += 1;
  });
  const action = (): ExternalAgentAction => ({ view: view() });
  const current = (request: ExternalAgentAction) => alive && active() && request.view === view();
  const disabled = () =>
    loading() || operations.busy() || !operations.pendingKnown() || operations.pending().length > 0;
  const source = async () => (await host.query('management', 'read', {})).source.reference;
  const observeBasis = async (): Promise<Basis> => {
    const before = await source();
    const status = (await host.query('agent', 'externalAgents', {
      inspect: true,
    })) as AgentExternalAgents;
    const after = await source();
    if (!sameValue(before, after))
      throw new UiError('These settings changed elsewhere. Reload before saving again.');
    if (
      status.target.source.stateDomain !== after.stateDomain ||
      status.target.source.deployment !== after.deployment
    )
      throw new UiError('This agent belongs to another deployment and cannot be configured here.');
    return {
      source: after,
      target: {
        instance: status.target,
        configured: status.configured,
        runtimes: status.runtimes,
      },
    };
  };
  const invalidate = () => {
    view.set(view() + 1);
    basis.set(null);
    confirmation.set(null);
    catalog.set(null);
    details.set(null);
  };
  const load = async () => {
    if (!alive || !active() || loading()) return;
    const generation = ++read;
    loading.set(true);
    failure.set(null);
    invalidate();
    try {
      const next = await observeBasis();
      if (!alive || !active() || generation !== read) return;
      basis.set(next);
      const status = next.target.runtimes.some((runtime) => runtime.enabled)
        ? await host.query('agent', 'externalAgents', {})
        : null;
      if (!alive || !active() || generation !== read) return;
      const latest = await source();
      if (!alive || !active() || generation !== read) return;
      if (!sameValue(next.source, latest)) {
        invalidate();
        throw new UiError('These settings changed elsewhere. Reload before saving again.');
      }
      if (!alive || !active() || generation !== read) return;
      catalog.set(status);
    } catch (error) {
      if (alive && active() && generation === read) {
        failure.set(errorMessage(error));
        operations.report(new UiError('Could not check external agents. Open details or refresh.'));
      }
    } finally {
      if (alive && generation === read) loading.set(false);
    }
  };
  const verify = async (original: Basis, request: ExternalAgentAction) => {
    const observed = await observeBasis();
    if (!current(request)) return false;
    if (!sameValue(original, observed)) {
      invalidate();
      throw new UiError('These settings changed elsewhere. Reload before saving again.');
    }
    return true;
  };
  const run = (operation: () => Promise<void>) =>
    operations.run(async () => {
      failure.set(null);
      try {
        await operation();
      } catch (error) {
        failure.set(errorMessage(error));
        throw new UiError('Could not update external agents. Open details or refresh.');
      }
    });
  const save = (request: ExternalAgentAction, runtime: string, enabled: boolean) => {
    if (!current(request) || disabled()) return;
    const original = enabled ? confirmation()?.basis : basis();
    if (
      !original ||
      !runtime ||
      (enabled && (!confirmation()?.acknowledged || confirmation()?.runtime !== runtime))
    )
      return;
    if (!original.target.runtimes.some((item) => item.id === runtime)) return;
    return run(async () => {
      if (!(await verify(original, request))) return;
      const { instance, configured } = original.target;
      const changes: SettingChange[] = [];
      if (!configured) changes.push({ path: instance.path as [string, ...string[]] });
      changes.push({
        path: instance.path.concat('runtimes', runtime) as [string, ...string[]],
        value: { kind: 'boolean', value: enabled },
      });
      // Remove consent before dispatch. Unknown receipts remain in the existing journal,
      // never in a second retryable enable request.
      confirmation.set(null);
      view.set(view() + 1);
      const result: ManagementResultForDeploymentRef = await operations.mutate(
        'management',
        'configureBatch',
        {
          expectedRevision: original.source.revision,
          edits: [{ instance: instance.source.namespace, changes }],
        },
      );
      if (result.status !== 'committed') {
        if (result.status === 'conflict')
          throw new UiError('These settings changed elsewhere. Reload before saving again.');
        if (result.diagnostic) throw new UiError('Error: {detail}', { detail: result.diagnostic });
        throw new UiError('The Host rejected this service change. Reload and review it.');
      }
      invalidate();
      await host.refresh();
      changed();
      await load();
    });
  };
  const requestEnable = (request: ExternalAgentAction & { runtime: string }) => {
    if (!current(request) || disabled() || !basis()) return;
    const runtime = runtimes().find((item) => item.id === request.runtime);
    if (!runtime) return;
    view.set(view() + 1);
    confirmation.set({
      basis: basis()!,
      runtime: runtime.id,
      name: runtime.name,
      acknowledged: false,
    });
  };
  const acknowledge = (request: ExternalAgentAction & { value: boolean }) => {
    if (!current(request) || disabled() || !confirmation()) return;
    confirmation.set({ ...confirmation()!, acknowledged: request.value });
  };
  const cancel = (request: ExternalAgentAction) => {
    if (!current(request) || disabled()) return;
    view.set(view() + 1);
    confirmation.set(null);
  };
  const runtimes = (): AgentExternalAgents['runtimes'] => basis()?.target.runtimes ?? [];
  const statuses = (): AgentExternalRuntime[] => {
    const state = catalog()?.state;
    return state?.kind === 'ready' ? state.runtimes : [];
  };
  const reload = (request: ExternalAgentAction) => {
    if (!current(request) || disabled()) return;
    operations.error.set('');
    void load();
  };
  const deactivate = () => {
    read += 1;
    loading.set(false);
    invalidate();
  };
  const reset = () => {
    deactivate();
    if (active()) void load();
  };
  return {
    basis,
    catalog,
    details,
    failure,
    toggleDetails: (request: ExternalAgentAction & { runtime: string }) => {
      if (!current(request)) return;
      details.set(details() === request.runtime ? null : request.runtime);
    },
    status: (runtime: string) => statuses().find((item) => item.id === runtime),
    confirmation,
    loading,
    disabled,
    action,
    runtimes,
    requestEnable,
    acknowledge,
    cancel,
    reload,
    refresh() {
      if (!confirmation() && !disabled()) void load();
    },
    enable: (request: ExternalAgentAction) => save(request, confirmation()?.runtime ?? '', true),
    disable: (request: ExternalAgentAction & { runtime: string }) =>
      save(request, request.runtime, false),
    activate: () => {
      if (!basis()) void load();
    },
    deactivate,
    reset,
    navigation: () => JSON.stringify(action()),
    back: () => {
      if (confirmation()) {
        cancel(action());
        return false;
      }
      return true;
    },
    title: () =>
      confirmation() ? tr('Enable {name}', { name: confirmation()!.name }) : tr('External agents'),
  };
}
export type ExternalAgentSettingsOwner = ReturnType<typeof createExternalAgentSettings>;
