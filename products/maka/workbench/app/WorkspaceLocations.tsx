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

import { LoadingIndicator } from './Loading';
import { cleanup, inputAction, List, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { Button } from 'nsh/base';
import { windowSize } from 'nsh';
import type {
  DirectoryRootSpec,
  ServiceMethods,
} from '../../../../packages/plugin-sdk/src/index.js';
import { useHost } from './host';
import { tr } from './locale';
import { createSettingsOperations } from './settingsOperations';
import { UiError } from './text';
import { createPendingRecovery } from './pendingRecovery';
import {
  C,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  inputBorderRadius,
} from './ui';

type SettingsWorkspaceLocations = NonNullable<
  ServiceMethods['settings']['workspaceLocations']['output']
>;

export function WorkspaceLocations(props: { close(roots: DirectoryRootSpec[] | null): void }) {
  const host = useHost();
  const operations = createSettingsOperations(host);
  const snapshot = signal<SettingsWorkspaceLocations | null>(null);
  const roots = signal<DirectoryRootSpec[]>([]);
  const label = signal('');
  const path = signal('');
  const reading = signal(false);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const locked = () => reading() || operations.busy();
  const load = async () => {
    if (locked()) return;
    reading.set(true);
    operations.error.set('');
    try {
      await host.refresh();
      const value: SettingsWorkspaceLocations | null = await host.query(
        'settings',
        'workspaceLocations',
        {},
      );
      if (!alive) return;
      snapshot.set(value);
      roots.set(value?.roots ?? []);
      if (!value) throw new UiError('This Host does not manage workspace locations.');
    } catch (reason) {
      operations.report(reason);
    } finally {
      if (alive) reading.set(false);
    }
  };
  const add = () => {
    if (locked() || !label().trim() || !path().trim()) return;
    roots.set([...roots(), { label: label().trim(), path: path() }]);
    label.set('');
    path.set('');
  };
  const remove = (index: number) => {
    if (!locked()) roots.set(roots().filter((_, i) => i !== index));
  };
  const accept = (value: any) => {
    if (value?.status === 'committed') {
      props.close(value.value.roots);
      return;
    }
    if (value?.status === 'conflict')
      throw new UiError('Workspace locations changed elsewhere. Reload before saving again.');
    if (typeof value?.diagnostic === 'string') throw new Error(value.diagnostic);
    throw new UiError('The Host rejected these workspace locations.');
  };
  const save = () =>
    void operations.run(async () => {
      const current = snapshot();
      if (!current || label().trim() || path().trim()) return;
      await host.refresh();
      accept(
        await operations.mutate('settings', 'updateWorkspaceLocations', {
          source: current.source,
          roots: roots(),
        }),
      );
    });
  const recover = () =>
    operations.recover((original, value) => {
      if (original.endpoint === 'settings' && original.method === 'updateWorkspaceLocations')
        accept(value);
    });
  createPendingRecovery({
    pending: () => !operations.pendingKnown() || operations.pending().length > 0,
    blocked: locked,
    recover,
  });
  const button = {
    style: controlStyle,
    get hoverStyle() {
      return controlHoverStyle();
    },
    get focusStyle() {
      return controlFocusStyle();
    },
    disabledStyle: controlDisabledStyle,
  };
  const inputStyle = () => ({
    height: 36,
    paddingHorizontal: 12,
    color: C.text,
    placeholderColor: C.muted,
    backgroundColor: C.background,
    borderRadius: inputBorderRadius,
    fontSize: 14,
  });
  void load();
  return (
    <View
      style={{
        width: '100%',
        maxWidth: 680,
        height: Math.min(560, windowSize().height - 32),
        maxHeight: '100%',
        backgroundColor: C.surface,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: 16,
        padding: 16,
        gap: 12,
      }}
    >
      <Text style={{ color: C.text, fontSize: 18, fontWeight: '600' }}>
        {tr('Manage workspace locations')}
      </Text>
      <Text style={{ color: C.muted, fontSize: 13 }}>
        {tr(
          'Add absolute folder paths on this Host. Removing a location does not delete its files.',
        )}
      </Text>
      <If when={operations.error()}>
        <Text style={[{ color: C.danger, fontSize: 13 }, { userSelect: 'text' }]}>
          {operations.error()}
        </Text>
      </If>
      <If when={reading()}>
        <LoadingIndicator label={tr('Loading locations…')} />
      </If>
      <If when={operations.pending().length > 0}>
        <Text style={{ color: C.muted, fontSize: 13 }}>{tr('Checking action status…')}</Text>
      </If>
      <List
        each={roots().map((root, index) => ({ ...root, index }))}
        keyExtractor={(root) => String(root.index)}
        estimatedItemSize={60}
        style={{ flex: 1, minHeight: 32 }}
        accessibilityLabel={tr('Published workspace locations')}
      >
        {(root) => (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 8 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <Text style={[{ color: C.text, fontSize: 14, lineHeight: 18 }, { numberOfLines: 1 }]}>
                {root().label}
              </Text>
              <Text
                style={[
                  { color: C.muted, fontSize: 12, lineHeight: 16 },
                  { userSelect: 'text', numberOfLines: 1 },
                ]}
              >
                {root().path}
              </Text>
            </View>
            <Button
              {...button}
              disabled={locked()}
              accessibilityLabel={tr('Remove location {name}', { name: root().label })}
              onPress={inputAction(remove, root().index)}
            >
              <Text style={{ color: C.secondary, fontSize: 13 }}>{tr('Remove')}</Text>
            </Button>
          </View>
        )}
      </List>
      <Input
        value={label()}
        onChange={({ value }) => label.set(value)}
        readonly={locked()}
        accessibilityLabel={tr('Workspace location name')}
        placeholder={tr('Location name')}
        style={inputStyle()}
      />
      <Input
        value={path()}
        onChange={({ value }) => path.set(value)}
        readonly={locked()}
        accessibilityLabel={tr('Workspace location path')}
        placeholder={tr('Absolute folder path on this Host')}
        style={inputStyle()}
      />
      <Button
        {...button}
        disabled={locked() || !snapshot() || !label().trim() || !path().trim()}
        accessibilityLabel={tr('Add workspace location')}
        onPress={inputAction(add, null)}
      >
        <Text style={{ color: C.accent, fontSize: 13 }}>{tr('Add location')}</Text>
      </Button>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
        <Button
          {...button}
          disabled={locked()}
          accessibilityLabel={tr('Reload')}
          onPress={inputAction(() => void load(), null)}
        >
          <Text style={{ color: C.secondary, fontSize: 13 }}>{tr('Reload')}</Text>
        </Button>
        <Button
          {...button}
          disabled={operations.busy()}
          accessibilityLabel={tr('Back')}
          onPress={inputAction(props.close, null)}
        >
          <Text style={{ color: C.secondary, fontSize: 13 }}>{tr('Back')}</Text>
        </Button>
        <Button
          {...button}
          disabled={
            locked() ||
            !snapshot() ||
            !operations.pendingKnown() ||
            operations.pending().length > 0 ||
            !!label().trim() ||
            !!path().trim()
          }
          accessibilityLabel={tr('Save workspace locations')}
          onPress={inputAction(save, null)}
        >
          <Text style={{ color: C.accent, fontSize: 13 }}>
            {operations.busy() ? tr('Saving…') : tr('Save locations')}
          </Text>
        </Button>
      </View>
    </View>
  );
}
