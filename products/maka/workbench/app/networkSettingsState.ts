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
import { host } from './host';
import { tr } from './locale';
import { message, UiError } from './text';
import type {
  NetworkProxy,
  ProxyProtocol,
  SettingsNetworkSnapshot,
  SettingsNetworkUpdate,
  SettingsNetworkUpdated,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import { credentialBasis, settingsRejection, type SettingsOperations } from './settingsOperations';

type CredentialAction = SettingsNetworkUpdate['credential'];
type Draft = {
  proxy: NetworkProxy;
  port: string;
  bypass: string;
  credential: CredentialAction;
  secret: string;
};
export type NetworkAction = { view: number; revision: number | null };
type Choice = NetworkAction &
  (
    | { kind: 'enabled' | 'authentication'; value: boolean }
    | { kind: 'protocol'; value: ProxyProtocol }
    | { kind: 'credential'; value: CredentialAction }
  );

export function createNetworkSettings(operations: SettingsOperations, active: () => boolean) {
  const snapshot = signal<SettingsNetworkSnapshot | null>(null);
  const draft = signal<Draft | null>(null);
  const loading = signal(false);
  let alive = true;
  let read = 0;
  let view = 0;
  cleanup(() => {
    alive = false;
    read += 1;
    draft.set(null);
  });
  const action = (): NetworkAction => ({ view, revision: snapshot()?.revision ?? null });
  const current = (request: NetworkAction) =>
    alive &&
    active() &&
    request.view === view &&
    request.revision === (snapshot()?.revision ?? null);
  const disabled = () =>
    operations.busy() || loading() || !operations.pendingKnown() || operations.pending().length > 0;
  const load = async () => {
    if (!alive || !active() || loading()) return;
    const generation = ++read;
    loading.set(true);
    try {
      const next: SettingsNetworkSnapshot = await host.query('settings', 'network', {});
      if (!alive || !active() || generation !== read) return;
      view += 1;
      snapshot.set(next);
      draft.set({
        proxy: { ...next.proxy },
        port: String(next.proxy.port),
        bypass: next.proxy.bypassList.join('\n'),
        credential: next.proxy.authEnabled ? 'keep' : 'delete',
        secret: '',
      });
    } catch (reason) {
      if (alive && active() && generation === read) operations.report(reason);
    } finally {
      if (alive && generation === read) loading.set(false);
    }
  };
  const reload = (request: NetworkAction) => {
    if (!current(request) || operations.busy()) return;
    operations.error.set('');
    operations.notice.set('');
    void load();
  };
  const edit = (field: 'host' | 'port' | 'username' | 'bypass' | 'secret', text: string) => {
    const value = draft();
    if (!alive || !active() || !value || disabled()) return;
    if (field === 'host' || field === 'username')
      draft.set({ ...value, proxy: { ...value.proxy, [field]: text } });
    else draft.set({ ...value, [field]: text });
  };
  const choose = (request: Choice) => {
    const value = draft();
    if (!current(request) || !value || disabled()) return;
    if (request.kind === 'enabled')
      draft.set({ ...value, proxy: { ...value.proxy, enabled: request.value } });
    else if (request.kind === 'protocol')
      draft.set({ ...value, proxy: { ...value.proxy, protocol: request.value } });
    else if (request.kind === 'authentication')
      draft.set({
        ...value,
        proxy: { ...value.proxy, authEnabled: request.value },
        credential: request.value
          ? snapshot()?.credential.configured
            ? 'keep'
            : 'replace'
          : 'delete',
      });
    else if (request.kind === 'credential')
      draft.set({
        ...value,
        credential: request.value,
        secret: '',
        proxy: {
          ...value.proxy,
          authEnabled: request.value === 'delete' ? false : value.proxy.authEnabled,
        },
      });
  };
  const save = (request: NetworkAction) => {
    if (!current(request) || disabled()) return;
    return operations.run(async () => {
      const original = snapshot(),
        value = draft();
      if (!original || !value) return;
      const portText = value.port.trim();
      const port = portText === '' && !value.proxy.enabled ? 0 : Number(portText);
      if (
        (!/^\d+$/.test(portText) && !(portText === '' && !value.proxy.enabled)) ||
        !Number.isInteger(port) ||
        port < 0 ||
        port > 65535 ||
        (value.proxy.enabled && port === 0)
      )
        throw new UiError('Enter a proxy port from 1 to 65535, or turn off the proxy.');
      if (value.proxy.enabled && !value.proxy.host.trim())
        throw new UiError('Enter the proxy host.');
      const credential = value.proxy.authEnabled ? value.credential : 'delete';
      if (credential === 'replace' && !value.secret)
        throw new UiError('Enter the replacement proxy password.');
      if (value.proxy.authEnabled && credential === 'keep' && !original.credential.configured)
        throw new UiError('No proxy password is stored. Choose Replace password and enter one.');
      const input: SettingsNetworkUpdate = {
        expectedPolicyRevision: original.revision,
        expectedCredential: credentialBasis(original.credential),
        networkProxy: {
          ...value.proxy,
          port,
          bypassList: value.bypass
            .split('\n')
            .map((rule) => rule.trim())
            .filter(Boolean),
        },
        credential,
      };
      const result: SettingsNetworkUpdated = await operations.mutate(
        'settings',
        'updateNetwork',
        input,
        credential === 'replace' ? value.secret : null,
      );
      if (result.kind !== 'applied') throw settingsRejection(result);
      if (result.result.kind === 'proxy_target_mismatch')
        throw new UiError(
          'The stored password belongs to another proxy. Replace the password for this proxy or reload the original settings.',
        );
      if (result.result.kind !== 'committed') throw settingsRejection(result.result);
      if (!alive) return;
      // The write is known. Remove its editable basis before a refresh can fail;
      // a retry must never submit the already committed password again.
      view += 1;
      snapshot.set(null);
      draft.set(null);
      operations.notice.set(message('Network settings saved.'));
      await load();
    });
  };
  const activate = () => {
    if (!snapshot()) void load();
  };
  const deactivate = () => {
    read += 1;
    view += 1;
    loading.set(false);
  };
  const reset = () => {
    deactivate();
    snapshot.set(null);
    draft.set(null);
    if (active()) void load();
  };
  return {
    snapshot,
    draft,
    loading,
    disabled,
    action,
    navigation: () => JSON.stringify(action()),
    reload,
    edit,
    choose,
    save,
    activate,
    deactivate,
    reset,
    back: () => true,
    title: () => tr('Network settings'),
  };
}
export type NetworkSettingsOwner = ReturnType<typeof createNetworkSettings>;
