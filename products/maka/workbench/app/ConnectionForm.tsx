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

import { cleanup, computed, effect, inputAction, signal, Text } from 'nsh';
import type { CredentialStatus } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { ModelSettingsOwner } from './settings';
import { ConnectionLogin } from './ConnectionLogin';
import { useHost } from './host';
import { tr } from './locale';
import {
  SettingsBody,
  SettingsButton,
  SettingsInput,
  SettingsRow,
  SettingsSearch,
  SettingsSection,
  SettingsSwitch,
  SettingsTextArea,
} from './SettingsPage';
import { C, captionTextStyle } from './ui';

const blocked = (owner: ModelSettingsOwner) =>
  owner.busy() || owner.loading() || !owner.pendingKnown() || owner.pending().length > 0;

export function ConnectionForm(props: { settings: ModelSettingsOwner }) {
  const owner = props.settings;
  const form = () => owner.editor()!;
  const disabled = () => blocked(owner);
  const models = () => form().baseline?.editing?.enabledModelIds ?? [];
  const interactive = () =>
    form().provider.descriptor.authentication.some((method) => method.interactive);
  const usageAuthentication = () => form().provider.descriptor.usageAuthentication;
  const keyed = () =>
    form().provider.descriptor.authentication.some(
      (method) => method.id === 'api-key' && !method.interactive,
    );
  const canDiscover = () =>
    !disabled() &&
    !owner.dirty() &&
    (form().provider.descriptor.anonymous || !!owner.credential()?.configured);
  const name = (id: string) => form().baseline?.editing?.modelOverrides?.[id]?.displayName ?? id;
  const isDefault = (id: string) =>
    owner.defaultTarget()?.connectionId === form().baseline?.target.connectionId &&
    owner.defaultTarget()?.modelId === id;
  return (
    <SettingsBody
      footerShown={!form().baseline || owner.dirty()}
      footer={<ConnectionFooter owner={owner} />}
    >
      <If when={interactive()}>
        <ConnectionLogin owner={owner} disabled={disabled()} />
      </If>
      <SettingsSection>
        <If when={keyed()}>
          <SettingsInput
            label={tr('API key')}
            value={form().apiKey}
            masked
            placeholder={owner.credential()?.configured ? tr('Stored') : undefined}
            change={(text) => owner.edit('apiKey', text)}
            disabled={disabled()}
          />
        </If>
        <If when={form().provider.descriptor.customEndpoint}>
          <SettingsInput
            label={tr('Base URL')}
            value={form().baseUrl}
            change={(text) => owner.edit('baseUrl', text)}
            disabled={disabled()}
          />
        </If>
        <SettingsSwitch
          label={tr('Connection enabled')}
          checked={form().enabled}
          disabled={disabled()}
          onPress={inputAction(owner.toggleEnabled, {
            ...owner.action(),
            enabled: !form().enabled,
          })}
        />
      </SettingsSection>
      <If
        when={
          form().baseline &&
          (usageAuthentication() === 'access_key' || usageAuthentication() === 'team_access_key')
        }
      >
        <UsageAccessKey owner={owner} requiresTeam={usageAuthentication() === 'team_access_key'} />
      </If>
      <If when={form().baseline && (models().length > 8 || owner.modelQuery().trim())}>
        <SettingsSearch
          label={tr('Search models')}
          value={owner.modelQuery()}
          change={(text) => owner.modelQuery.set(text)}
        />
      </If>
      <If when={form().baseline}>
        <SettingsSection
          title={tr('Models · {count}', { count: models().length })}
          note={
            owner.dirty()
              ? tr('Save or discard the connection changes before editing models.')
              : owner.discovery() === 'failed'
                ? tr(
                    'Could not fetch models. Check the provider credential, endpoint and network, or add a model manually.',
                  )
                : undefined
          }
          trailing={
            <>
              <If when={form().provider.descriptor.discovery}>
                <SettingsButton
                  label={
                    owner.discovery() === 'fetching' ? tr('Fetching models…') : tr('Fetch models')
                  }
                  accessibilityLabel={tr('Fetch models')}
                  tone="quiet"
                  icon="refresh"
                  disabled={!canDiscover()}
                  onPress={inputAction(owner.discover, owner.action())}
                />
              </If>
              <SettingsButton
                label={tr('Add model')}
                accessibilityLabel={tr('Add model manually')}
                tone="quiet"
                icon="plus"
                disabled={disabled() || owner.dirty()}
                onPress={inputAction(owner.editModel, { ...owner.action(), id: null })}
              />
            </>
          }
        >
          <Each of={owner.filteredModels()} key={(id) => id}>
            {(id) => (
              <SettingsRow
                label={name(id())}
                description={name(id()) === id() ? undefined : id()}
                accessibilityLabel={tr('Edit model {id}', { id: id() })}
                trailing={
                  <If when={isDefault(id())}>
                    <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Default')}</Text>
                  </If>
                }
                opens
                disabled={disabled() || owner.dirty()}
                onPress={inputAction(owner.editModel, { ...owner.action(), id: id() })}
              />
            )}
          </Each>
          <If when={!owner.filteredModels().length && owner.discovery() !== 'fetching'}>
            <SettingsRow
              label={
                owner.modelQuery().trim() ? tr('No matching models.') : tr('No models added yet.')
              }
              tone="muted"
            />
          </If>
        </SettingsSection>
      </If>
      <SettingsSection>
        <SettingsRow
          label={tr('Advanced')}
          accessibilityLabel={tr('Advanced connection settings')}
          opens
          disabled={disabled()}
          onPress={inputAction(owner.showAdvanced, owner.action())}
        />
        <If when={form().baseline}>
          <SettingsRow
            label={tr('Delete connection')}
            tone="danger"
            disabled={disabled()}
            onPress={inputAction(owner.confirm, {
              ...owner.action(),
              kind: 'connection',
              modelId: null,
            })}
          />
        </If>
      </SettingsSection>
    </SettingsBody>
  );
}

function UsageAccessKey(props: { owner: ModelSettingsOwner; requiresTeam: boolean }) {
  const owner = props.owner;
  const host = useHost();
  const connectionId = computed(() => owner.editor()?.baseline?.target.connectionId);
  const state = signal<CredentialStatus | 'failed' | null>(null);
  const status = () => {
    const value = state();
    return value === 'failed' ? null : value;
  };
  const accessKeyId = signal('');
  const secretAccessKey = signal('');
  const teamId = signal('');
  let read = 0;
  cleanup(() => {
    read += 1;
  });
  effect(() => {
    const id = connectionId();
    if (!id) return;
    const request = ++read;
    state.set(null);
    void host
      .query('settings', 'credentialStatus', {
        locator: { scope: 'connection', connectionId: id, kind: 'usage' },
      })
      .then(
        (result) => {
          if (request !== read) return;
          state.set(result.kind === 'status' ? result.status : 'failed');
        },
        () => {
          if (request === read) state.set('failed');
        },
      );
  });
  const disabled = () => blocked(owner) || !status();
  const update = async (remove: boolean) => {
    const before = status();
    if (!before || disabled()) return;
    const request = read;
    const updated = await owner.setUsageAccessKey(
      owner.action(),
      before,
      remove
        ? null
        : {
            accessKeyId: accessKeyId().trim(),
            secretAccessKey: secretAccessKey().trim(),
            ...(props.requiresTeam ? { teamId: teamId().trim() } : {}),
          },
    );
    if (!updated || request !== read) return;
    state.set(updated);
    accessKeyId.set('');
    secretAccessKey.set('');
    teamId.set('');
  };
  return (
    <SettingsSection
      title={tr('Usage access key')}
      note={state() === 'failed' ? tr('Usage limits unavailable') : undefined}
    >
      <SettingsInput
        label={tr('Access key ID')}
        value={accessKeyId()}
        placeholder={status()?.configured ? tr('Stored') : undefined}
        change={(value) => accessKeyId.set(value)}
        masked
        disabled={disabled()}
      />
      <SettingsInput
        label={tr('Secret access key')}
        value={secretAccessKey()}
        placeholder={status()?.configured ? tr('Stored') : undefined}
        change={(value) => secretAccessKey.set(value)}
        masked
        disabled={disabled()}
      />
      <If when={props.requiresTeam}>
        <SettingsInput
          label={tr('Token Plan ID')}
          value={teamId()}
          placeholder={status()?.configured ? tr('Stored') : undefined}
          change={(value) => teamId.set(value)}
          disabled={disabled()}
        />
      </If>
      <SettingsRow
        label={tr('Save usage access key')}
        disabled={
          disabled() ||
          !accessKeyId().trim() ||
          !secretAccessKey().trim() ||
          (props.requiresTeam && !teamId().trim())
        }
        onPress={() => void update(false)}
      />
      <If when={status()?.configured}>
        <SettingsRow
          label={tr('Remove usage access key')}
          tone="danger"
          disabled={disabled()}
          onPress={() => void update(true)}
        />
      </If>
    </SettingsSection>
  );
}

export function ConnectionAdvanced(props: { settings: ModelSettingsOwner }) {
  const owner = props.settings;
  const form = () => owner.editor()!;
  const disabled = () => blocked(owner);
  const interactive = () =>
    form().provider.descriptor.authentication.some((method) => method.interactive);
  return (
    <SettingsBody
      footerShown={!form().baseline || owner.dirty()}
      footer={<ConnectionFooter owner={owner} />}
    >
      <SettingsSection
        note={
          form().baseline
            ? undefined
            : tr('A unique lowercase name, such as openrouter-work. It stays fixed after creation.')
        }
      >
        <SettingsInput
          label={tr('Connection name')}
          value={form().name}
          change={(text) => owner.edit('name', text)}
          disabled={disabled()}
        />
        <SettingsInput
          label={tr('Connection ID')}
          value={form().slug}
          change={(text) => owner.edit('slug', text)}
          disabled={disabled()}
          readonly={!!form().baseline}
        />
        <If when={owner.editableBaseUrl() && !form().provider.descriptor.customEndpoint}>
          <SettingsInput
            label={tr('Base URL')}
            value={form().baseUrl}
            change={(text) => owner.edit('baseUrl', text)}
            disabled={disabled()}
          />
        </If>
      </SettingsSection>
      <If when={owner.supportsServerSideCompaction()}>
        <SettingsSection>
          <SettingsSwitch
            label={tr('Provider server-side compaction')}
            checked={form().serverSideCompaction}
            disabled={disabled()}
            onPress={inputAction(owner.toggleServerSideCompaction, {
              ...owner.action(),
              enabled: !form().serverSideCompaction,
            })}
          />
        </SettingsSection>
      </If>
      <SettingsSection
        title={tr('Advanced request JSON')}
        note={tr('Merged into model requests. Use null to clear.')}
      >
        <SettingsTextArea
          label={tr('Advanced request JSON')}
          value={form().overlay}
          lines={6}
          monospace
          change={(text) => owner.edit('overlay', text)}
          disabled={disabled()}
        />
      </SettingsSection>
      <If when={owner.credential()?.configured}>
        <SettingsSection>
          <SettingsRow
            label={interactive() ? tr('Sign out') : tr('Remove stored provider credential')}
            tone="danger"
            disabled={disabled() || owner.dirty()}
            onPress={inputAction(owner.confirm, {
              ...owner.action(),
              kind: 'key',
              modelId: null,
            })}
          />
        </SettingsSection>
      </If>
    </SettingsBody>
  );
}

function ConnectionFooter(props: { owner: ModelSettingsOwner }) {
  const owner = props.owner;
  const form = () => owner.editor()!;
  return (
    <>
      <If when={form().baseline}>
        <SettingsButton
          label={tr('Discard')}
          accessibilityLabel={tr('Discard changes and reload')}
          tone="quiet"
          disabled={blocked(owner)}
          onPress={inputAction(owner.reloadConnection, owner.action())}
        />
      </If>
      <SettingsButton
        label={
          owner.busy() && !owner.login.state() && owner.discovery() !== 'fetching'
            ? tr('Saving…')
            : tr('Save')
        }
        accessibilityLabel={tr('Save connection')}
        tone="primary"
        disabled={blocked(owner) || !owner.dirty()}
        onPress={inputAction(owner.saveConnection, owner.action())}
      />
    </>
  );
}
