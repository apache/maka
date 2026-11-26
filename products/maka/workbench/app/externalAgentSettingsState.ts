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

import { batch, cleanup, signal } from 'nsh';
import type {
  AgentExternalAgents,
  AgentExternalRuntime,
  DeploymentRef,
  SettingChange,
  ManagementResultForDeploymentRef,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { Host } from './host';
import { invalidateUsageLimits, isExternalUsageRuntime } from './usageLimitsReading';
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
class BasisMismatchError extends UiError {}
export type ExternalAgentAction = { view: number };
export function createExternalAgentSettings(
  host: Host,
  operations: SettingsOperations,
  active: () => boolean,
) {
  const basis = signal<Basis | null>(null);
  const catalog = signal<AgentExternalAgents | null>(null);
  const confirmation = signal<{
    basis: Basis;
    runtime: string;
    name: string;
    acknowledged: boolean;
  } | null>(null);
  const failure = signal<string | null>(null);
  const loading = signal(false);
  const checking = signal(false);
  let alive = true;
  const view = signal(0);
  let read = 0;
  cleanup(() => {
    alive = false;
    read += 1;
  });
  const action = (): ExternalAgentAction => ({ view: view() });
  const current = (request: ExternalAgentAction) => alive && active() && request.view === view();
  const busy = () =>
    operations.busy() || !operations.pendingKnown() || operations.pending().length > 0;
  const disabled = () => (loading() && !basis()) || busy();
  const source = async () => (await host.query('management', 'read', {})).source.reference;
  const observeBasis = async (): Promise<Basis> => {
    const before = await source();
    const status = (await host.query('agent', 'externalAgents', {
      inspect: true,
    })) as AgentExternalAgents;
    const after = await source();
    if (!sameValue(before, after)) {
      throw new BasisMismatchError('These settings changed elsewhere. Reload before saving again.');
    }
    if (
      status.target.source.stateDomain !== after.stateDomain ||
      status.target.source.deployment !== after.deployment
    ) {
      throw new BasisMismatchError(
        'This agent belongs to another deployment and cannot be configured here.',
      );
    }
    return {
      source: after,
      target: {
        instance: status.target,
        configured: status.configured,
        runtimes: status.runtimes,
      },
    };
  };
  const clearView = () => {
    view.set(view() + 1);
    basis.set(null);
    confirmation.set(null);
    catalog.set(null);
  };
  const invalidate = () => {
    read += 1;
    loading.set(false);
    checking.set(false);
    clearView();
  };
  const load = async (forceRefresh = false, retried = false): Promise<void> => {
    if (!alive || !active()) return;
    if (!forceRefresh && !retried && (loading() || checking())) return;
    const generation = ++read;
    const hasBasis = basis() !== null;
    if (!hasBasis) {
      loading.set(true);
      view.set(view() + 1);
    }
    failure.set(null);
    confirmation.set(null);
    try {
      const next = await observeBasis();
      if (!alive || !active() || generation !== read) return;
      const hasEnabled = next.target.runtimes.some((runtime) => runtime.enabled);
      batch(() => {
        basis.set(next);
        loading.set(false);
        if (!hasEnabled) {
          catalog.set(null);
          checking.set(false);
        } else {
          checking.set(true);
        }
      });
      if (!hasEnabled) return;
      const status = await host.query(
        'agent',
        'externalAgents',
        forceRefresh ? { refresh: true } : {},
      );
      if (!alive || !active() || generation !== read) return;
      const latest = await source();
      if (!alive || !active() || generation !== read) return;
      if (!sameValue(next.source, latest)) {
        if (!retried) {
          checking.set(false);
          await load(forceRefresh, true);
          return;
        }
        throw new BasisMismatchError(
          'These settings changed elsewhere. Reload before saving again.',
        );
      }
      catalog.set(status);
    } catch (error) {
      if (alive && active() && generation === read) {
        if (error instanceof BasisMismatchError) clearView();
        failure.set(errorMessage(error));
      }
    } finally {
      if (alive && generation === read) {
        loading.set(false);
        checking.set(false);
      }
    }
  };
  const verify = async (original: Basis, request: ExternalAgentAction) => {
    let observed: Basis;
    try {
      observed = await observeBasis();
    } catch (error) {
      if (!current(request)) return false;
      if (error instanceof BasisMismatchError) invalidate();
      throw error;
    }
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
      await operation();
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
      if (isExternalUsageRuntime(runtime))
        invalidateUsageLimits(host, { kind: 'external', runtime });
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
    if (!current(request) || busy()) return;
    for (const runtime of runtimes()) {
      if (runtime.enabled && runtime.usageLimits && isExternalUsageRuntime(runtime.id)) {
        invalidateUsageLimits(host, { kind: 'external', runtime: runtime.id });
      }
    }
    void load(true);
  };
  const deactivate = () => {
    read += 1;
    loading.set(false);
    checking.set(false);
    confirmation.set(null);
    view.set(view() + 1);
  };
  const reset = () => {
    invalidate();
    if (active()) void load(false);
  };
  return {
    basis,
    catalog,
    failure,
    status: (runtime: string) => statuses().find((item) => item.id === runtime),
    confirmation,
    loading,
    checking,
    disabled,
    action,
    runtimes,
    requestEnable,
    acknowledge,
    cancel,
    reload,
    refresh() {
      if (!confirmation() && !busy()) void load(false);
    },
    enable: (request: ExternalAgentAction) => save(request, confirmation()?.runtime ?? '', true),
    disable: (request: ExternalAgentAction & { runtime: string }) =>
      save(request, request.runtime, false),
    activate: () => {
      void load(false);
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
