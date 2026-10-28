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

import { batch, cleanup, computed, signal } from 'nsh';
import { host } from './host';
import { tr } from './locale';
import { message, UiError } from './text';
import { sameValue as same } from '../../../../plugins/shared/value';
import type {
  DeploymentRef,
  InstanceId,
  InstanceSettingsPage,
  InstanceSettingsRead,
  ManagedInstance,
  SettingField,
  SettingValue,
  ManagementResultForDeploymentRef,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { SettingsOperations } from './settingsOperations';
import { createRootUiSettings } from './rootUiSettingsState';
import { pluginContext } from './plugins/context';

type Path = InstanceSettingsRead['path'];
type Inventory = { source: DeploymentRef; instances: ManagedInstance[] };
type Editor = { field: SettingField; value: SettingValue | null };
type Fields = Pick<InstanceSettingsPage, 'source' | 'instance' | 'path' | 'next'> & {
  fields: SettingField[];
};
export type PluginAction = {
  view: number;
  revision: number | null;
  instance: InstanceId | null;
  path: string[];
  field: string | null;
};
export const pluginTitle = (instance: ManagedInstance) =>
  instance.presentation?.displayName || instance.path.join(' / ');
export const settingCaption = (value: SettingValue | null | undefined) =>
  value?.kind === 'text' || value?.kind === 'number'
    ? value.text
    : value?.kind === 'boolean'
      ? String(value.value)
      : value?.kind === 'null'
        ? 'null'
        : tr('Not set');

// This is a read projection and an unsaved field, never another deployment
// manager. The original Host source and Settings journal own every change.
export function createPluginSettings(operations: SettingsOperations, active: () => boolean) {
  const inventory = signal<Inventory | null>(null);
  const selected = signal<ManagedInstance | null>(null);
  const fields = signal<Fields | null>(null);
  const editor = signal<Editor | null>(null);
  const query = signal('');
  const loading = signal(false);
  const view = signal(0);
  let alive = true,
    enabled = false,
    generation = 0;
  // Continuation failures stop automatic reads until navigation or refresh,
  // while the loaded fields and separately owned editor remain usable.
  let paging: 'ready' | 'loading' | 'failed' = 'ready';
  const visible = () => alive && enabled && active();
  const runtime = pluginContext()!;
  const rootUi = createRootUiSettings(runtime, runtime.context, visible);
  const action = (): PluginAction => ({
    view: view(),
    revision: fields()?.source.revision ?? inventory()?.source.revision ?? null,
    instance: selected()?.instance ?? null,
    path: fields()?.path ?? [],
    field: editor()?.field.key ?? null,
  });
  const current = (request: PluginAction) => visible() && same(request, action());
  const disabled = () =>
    !visible() ||
    loading() ||
    operations.busy() ||
    !operations.pendingKnown() ||
    operations.pending().length > 0 ||
    inventory() === null;
  const cancelRead = () => {
    generation += 1;
    view.set(view() + 1);
    loading.set(false);
    paging = 'ready';
  };
  const readFields = async (instance: ManagedInstance, source: DeploymentRef, path: Path) => {
    const reading = ++generation;
    fields.set(null);
    loading.set(true);
    try {
      const result = await host.query('management', 'readSettings', {
        source,
        instance: instance.instance,
        path,
        after: null,
      });
      if (!visible() || reading !== generation) return;
      if (
        !same(result.source, source) ||
        !same(result.instance, instance.instance) ||
        !same(result.path, path)
      )
        throw new UiError('Plugin settings returned a different target.');
      batch(() => {
        loading.set(false);
        fields.set(result);
      });
    } catch (reason) {
      if (visible() && reading === generation) operations.report(reason);
    } finally {
      if (alive && reading === generation) loading.set(false);
    }
  };
  const load = async (keep: InstanceId | null = selected()?.instance ?? null) => {
    if (!visible()) return;
    const reading = ++generation;
    batch(() => {
      inventory.set(null);
      fields.set(null);
      loading.set(true);
    });
    try {
      const first = await host.query('management', 'instances', { kind: 'start' });
      if (!visible() || reading !== generation) return;
      const instances = [...first.instances];
      let after = first.next ?? null;
      while (after !== null) {
        const next = await host.query('management', 'instances', {
          kind: 'continue',
          source: first.source,
          after,
        });
        if (!visible() || reading !== generation) return;
        if (!same(next.source, first.source))
          throw new UiError('Plugin inventory changed its source while reading.');
        if (same(next.next, after)) throw new UiError('Plugin inventory paging did not advance.');
        instances.push(...next.instances);
        after = next.next ?? null;
      }
      if (!visible() || reading !== generation) return;
      const retained = keep
        ? (instances.find((instance) => same(instance.instance, keep)) ?? null)
        : null;
      batch(() => {
        inventory.set({ source: first.source, instances });
        selected.set(retained);
        loading.set(false);
      });
      if (retained && !retained.structural) await readFields(retained, first.source, []);
    } catch (reason) {
      if (visible() && reading === generation) operations.report(reason);
    } finally {
      if (alive && reading === generation) loading.set(false);
    }
  };
  const settle = async (result: ManagementResultForDeploymentRef) => {
    if (result.status === 'conflict')
      throw new UiError(
        'Plugin configuration changed elsewhere. Discard this edit and refresh before trying again.',
      );
    if (result.status === 'rejected')
      throw new UiError('Plugin change rejected: {reason}', {
        reason: result.diagnostic ?? result.reason,
      });
    // Retire the original editor before IO. Read failure cannot expose an
    // already committed value as another new save.
    const keep = selected()?.instance ?? null;
    batch(() => {
      cancelRead();
      editor.set(null);
      inventory.set(null);
      fields.set(null);
    });
    operations.notice.set(
      message(
        'Plugin configuration saved. Enabled is the desired state; services may still be reconciling.',
      ),
    );
    if (visible()) await load(keep);
  };
  const back = () => {
    if (operations.busy()) return false;
    if (editor()) {
      batch(() => {
        editor.set(null);
        view.set(view() + 1);
      });
      return false;
    }
    const instance = selected();
    if (!instance) return true;
    const page = fields();
    cancelRead();
    if (page?.path.length && inventory()) {
      void readFields(instance, inventory()!.source, page.path.slice(0, -1) as Path);
    } else {
      selected.set(null);
      fields.set(null);
    }
    return false;
  };
  cleanup(() => {
    alive = false;
    enabled = false;
    cancelRead();
  });
  return {
    rootUi,
    inventory,
    selected,
    fields,
    editor,
    query,
    loading,
    busy: operations.busy,
    disabled,
    action,
    navigation: () => JSON.stringify(action()),
    title: () =>
      editor() ? tr('Plugin setting') : selected() ? pluginTitle(selected()!) : tr('Plugins'),
    filtered: computed(
      () =>
        inventory()?.instances.filter((instance) =>
          `${pluginTitle(instance)} ${instance.path.join('/')} ${instance.package.id}`
            .toLowerCase()
            .includes(query().toLowerCase()),
        ) ?? [],
    ),
    activate() {
      if (!alive || enabled) return;
      enabled = true;
      rootUi.activate();
      cancelRead();
      if (!editor()) void load();
    },
    deactivate() {
      enabled = false;
      cancelRead();
    },
    reset() {
      cancelRead();
      editor.set(null);
      if (visible()) void load();
      else {
        inventory.set(null);
        fields.set(null);
      }
    },
    back,
    reload(request: PluginAction) {
      if (!current(request) || operations.busy() || loading()) return;
      cancelRead();
      editor.set(null);
      operations.error.set('');
      void load();
    },
    async loadMore(request: PluginAction) {
      const page = fields();
      if (!current(request) || loading() || paging !== 'ready' || page?.next == null) return;
      const reading = generation;
      const after = page.next;
      paging = 'loading';
      try {
        const next = await host.query('management', 'readSettings', {
          source: page.source,
          instance: page.instance,
          path: page.path,
          after,
        });
        if (!visible() || reading !== generation) return;
        if (
          !same(next.source, page.source) ||
          !same(next.instance, page.instance) ||
          !same(next.path, page.path)
        )
          throw new UiError(
            'Plugin settings changed their source while reading. Refresh to continue.',
          );
        if (next.next === after) throw new UiError('Plugin settings paging did not advance.');
        paging = 'ready';
        fields.set({ ...next, fields: [...page.fields, ...next.fields] });
      } catch (reason) {
        if (visible() && reading === generation) {
          paging = 'failed';
          operations.report(reason);
        }
      }
    },
    open({ request, instance }: { request: PluginAction; instance: InstanceId }) {
      if (!current(request) || disabled() || selected()) return;
      const target = inventory()!.instances.find((item) => same(item.instance, instance));
      if (!target) return;
      cancelRead();
      selected.set(target);
      fields.set(null);
      if (!target.structural) void readFields(target, inventory()!.source, []);
    },
    group({ request, key }: { request: PluginAction; key: string }) {
      const field = fields()?.fields.find((field) => field.key === key);
      if (
        !current(request) ||
        disabled() ||
        editor() ||
        !field?.editable ||
        !['object', 'array'].includes(field.kind)
      )
        return;
      cancelRead();
      void readFields(selected()!, inventory()!.source, [...request.path, key] as Path);
    },
    edit({ request, key }: { request: PluginAction; key: string }) {
      const field = fields()?.fields.find((field) => field.key === key);
      if (
        !current(request) ||
        disabled() ||
        editor() ||
        !field?.editable ||
        ['object', 'array', 'unsupported'].includes(field.kind)
      )
        return;
      batch(() => {
        view.set(view() + 1);
        editor.set({
          field,
          value:
            field.value ??
            (field.kind === 'boolean'
              ? { kind: 'boolean', value: false }
              : field.kind === 'number'
                ? { kind: 'number', text: '' }
                : field.kind === 'null'
                  ? { kind: 'null' }
                  : { kind: 'text', text: '' }),
        });
      });
    },
    change({ request, value }: { request: PluginAction; value: SettingValue | null }) {
      const form = editor();
      if (current(request) && !disabled() && form) editor.set({ ...form, value });
    },
    save({ request, value }: { request: PluginAction; value: SettingValue | null }) {
      const form = editor();
      if (
        !current(request) ||
        disabled() ||
        !form ||
        !same(form.value, value) ||
        request.revision === null
      )
        return;
      return operations.run(async () => {
        if (!current(request)) return;
        await settle(
          await operations.mutate('management', 'configure', {
            expectedRevision: request.revision,
            instance: request.instance,
            changes: [{ path: [...request.path, form.field.key], value }],
          }),
        );
      });
    },
    toggle({ request, enabled: next }: { request: PluginAction; enabled: boolean }) {
      const instance = selected();
      if (
        !current(request) ||
        disabled() ||
        editor() ||
        !instance ||
        request.revision === null ||
        (next && instance.parentDisabled) ||
        next === !instance.disabled
      )
        return;
      return operations.run(async () => {
        if (!current(request)) return;
        await settle(
          await operations.mutate('management', 'setEnabled', {
            expectedRevision: request.revision,
            instance: instance.instance,
            enabled: next,
          }),
        );
      });
    },
  };
}
export type PluginSettingsOwner = ReturnType<typeof createPluginSettings>;
