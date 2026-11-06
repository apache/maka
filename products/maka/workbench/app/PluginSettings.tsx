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

import { inputAction, List } from 'nsh';
import { tr } from './locale';
import type {
  ManagedInstance,
  SettingField,
  SettingValue,
} from '../../../../packages/plugin-sdk/src/index.js';
import { sameValue } from '../../../../plugins/shared/value';
import { pluginTitle, settingCaption } from './pluginSettingsState.ts';
import type { PluginSettingsOwner, PluginAction } from './pluginSettingsState.ts';
import { ChoiceIndicator } from './ChoiceIndicator';
import { LoadingIndicator } from './Loading';
import { RootUiSettings } from './RootUiSettings';
import {
  SettingsBody,
  SettingsFormFooter,
  SettingsInput,
  SettingsLede,
  SettingsProblem,
  SettingsRow,
  SettingsSearch,
  SettingsSection,
  SettingsSegmented,
  SettingsSelect,
  SettingsSwitch,
  SettingsTextArea,
} from './SettingsPage';

export function PluginSettings(props: { owner: PluginSettingsOwner }) {
  const owner = props.owner;
  return (
    <If
      when={owner.inventory()}
      else={
        <SettingsBody>
          <If
            when={owner.loading()}
            else={
              <SettingsProblem
                message={tr('Plugin settings are unavailable on this connection.')}
                retry={inputAction(owner.reload, owner.action())}
              />
            }
          >
            <LoadingIndicator label={tr('Reading plugins…')} />
          </If>
        </SettingsBody>
      }
    >
      <Each of={[owner.navigation()]} key={(identity) => identity}>
        {() => {
          const request = owner.action();
          return (
            <If when={owner.selected()} else={<PluginList owner={owner} request={request} />}>
              <If when={owner.editor()} else={<PluginDetail owner={owner} request={request} />}>
                <PluginField owner={owner} request={request} />
              </If>
            </If>
          );
        }}
      </Each>
    </If>
  );
}

function PluginList(props: { owner: PluginSettingsOwner; request: PluginAction }) {
  const owner = props.owner;
  return (
    <SettingsBody>
      <SettingsSection>
        <RootUiSettings owner={owner.rootUi} />
      </SettingsSection>
      <If when={(owner.inventory()?.instances.length ?? 0) > 8 || owner.query()}>
        <SettingsSearch
          label={tr('Search Host plugins')}
          value={owner.query()}
          change={(value) => owner.query.set(value)}
        />
      </If>
      <SettingsSection
        title={tr('Plugins')}
        note={tr('Manage plugins for this connection. Your conversation and draft stay open.')}
      >
        <Each<ManagedInstance>
          of={owner.filtered()}
          key={(instance) => JSON.stringify(instance.instance)}
        >
          {(row) => (
            <SettingsRow
              label={pluginTitle(row())}
              description={row().path.join(' / ')}
              tone={row().disabled ? 'muted' : undefined}
              status={row().parentDisabled ? tr('Parent disabled') : undefined}
              accessibilityLabel={tr('Open plugin {name}', { name: row().path.join(' / ') })}
              opens
              disabled={owner.disabled()}
              onPress={inputAction(owner.open, {
                request: props.request,
                instance: row().instance,
              })}
            />
          )}
        </Each>
        <If when={!owner.filtered().length}>
          <SettingsRow label={tr('No matching plugins.')} tone="muted" />
        </If>
      </SettingsSection>
    </SettingsBody>
  );
}

function PluginDetail(props: { owner: PluginSettingsOwner; request: PluginAction }) {
  const owner = props.owner;
  const request = props.request;
  const plugin = () => owner.selected()!;
  const locked = () => owner.disabled() || (plugin().disabled && plugin().parentDisabled);
  return (
    <SettingsBody>
      <If when={plugin().presentation?.description}>
        <SettingsLede>{plugin().presentation!.description!}</SettingsLede>
      </If>
      <SettingsSection
        note={tr(
          'Saved configuration · revision {revision}. Enabled shows the saved setting. Changes may take a moment to apply.',
          { revision: owner.inventory()!.source.revision },
        )}
      >
        <SettingsSwitch
          label={tr('Enabled')}
          accessibilityLabel={
            plugin().disabled ? tr('Enable Host plugin') : tr('Disable Host plugin')
          }
          status={
            plugin().parentDisabled
              ? tr('Enable the parent plugin before enabling this child.')
              : undefined
          }
          checked={!plugin().disabled}
          disabled={locked()}
          onPress={inputAction(owner.toggle, { request, enabled: plugin().disabled })}
        />
        <SettingsRow label={tr('Location')} description={plugin().path.join(' / ')} />
        <SettingsRow
          label={tr('Package')}
          description={`${plugin().package.id} · ${plugin().package.revision}`}
        />
      </SettingsSection>
      <If when={plugin().structural}>
        <SettingsLede>{tr('Open a plugin in this group to edit its settings.')}</SettingsLede>
      </If>
      <If when={owner.fields()}>
        <SettingsSection
          title={
            owner.fields()!.path.length
              ? `${tr('Configuration')} / ${owner.fields()!.path.join(' / ')}`
              : tr('Configuration')
          }
        >
          <List
            viewport="parent"
            each={owner.fields()!.fields}
            keyExtractor={(field) => field.key}
            estimatedItemSize={52}
            onLoadMore={() => void owner.loadMore(request)}
          >
            {(item) => (
              <Each<SettingField> of={[item()]} key={(field) => field.key}>
                {(row) => {
                  const field = row();
                  const group = ['object', 'array'].includes(field.kind);
                  return (
                    <SettingsRow
                      label={field.label}
                      description={
                        group
                          ? field.kind === 'array'
                            ? tr('List')
                            : tr('Group')
                          : field.editable
                            ? settingCaption(field.value)
                            : tr('Read only or private')
                      }
                      accessibilityLabel={
                        group
                          ? tr('Open plugin group {name}', { name: field.label })
                          : tr('Edit plugin setting {name}', { name: field.label })
                      }
                      opens
                      disabled={owner.disabled() || !field.editable}
                      onPress={
                        group
                          ? inputAction(owner.group, { request, key: field.key })
                          : inputAction(owner.edit, { request, key: field.key })
                      }
                    />
                  );
                }}
              </Each>
            )}
          </List>
          <If when={!owner.fields()!.fields.length}>
            <SettingsRow label={tr('No editable fields in this group.')} tone="muted" />
          </If>
        </SettingsSection>
      </If>
    </SettingsBody>
  );
}

function PluginField(props: { owner: PluginSettingsOwner; request: PluginAction }) {
  const owner = props.owner,
    request = props.request;
  const field = owner.editor()!.field;
  const value = () => owner.editor()?.value ?? null;
  const change = (next: SettingValue | null) => owner.change({ request, value: next });
  const typed = () =>
    value()?.kind === 'text' || value()?.kind === 'number'
      ? (value() as { text: string }).text
      : '';
  const special = (choice: SettingValue | null, label: string) => (
    <SettingsRow
      label={label}
      leading={
        <ChoiceIndicator
          kind="radio"
          checked={sameValue(value(), choice)}
          disabled={owner.disabled()}
        />
      }
      selected={sameValue(value(), choice)}
      disabled={owner.disabled()}
      onPress={() => change(choice)}
    />
  );
  return (
    <SettingsBody
      footer={
        <SettingsFormFooter
          saveLabel={tr('Save Host plugin setting')}
          canSave={!owner.disabled()}
          busy={owner.busy()}
          save={inputAction(owner.save, { request, value: value() })}
          cancel={() => owner.back()}
        />
      }
    >
      <If when={field.description}>
        <SettingsLede>{field.description!}</SettingsLede>
      </If>
      <SettingsSection title={field.label}>
        <If when={field.options.length > 0}>
          <SettingsSelect
            label={tr('Value')}
            value={value() === null ? null : JSON.stringify(value())}
            disabled={owner.disabled()}
            choices={field.options.map((choice) => ({
              value: JSON.stringify(choice),
              title: settingCaption(choice),
            }))}
            change={(text) => change(JSON.parse(text) as SettingValue)}
          />
        </If>
        <If when={field.options.length === 0 && field.kind === 'text'}>
          <SettingsTextArea
            label={tr('Plugin value {name}', { name: field.label })}
            value={typed()}
            lines={4}
            autoFocus
            disabled={owner.disabled()}
            change={(text) => change({ kind: 'text', text })}
          />
        </If>
        <If when={field.options.length === 0 && field.kind === 'number'}>
          <SettingsInput
            label={tr('Plugin value {name}', { name: field.label })}
            description={tr('Enter a number. Decimal text is kept exactly.')}
            value={typed()}
            autoFocus
            disabled={owner.disabled()}
            change={(text) => change({ kind: 'number', text })}
          />
        </If>
        <If when={field.options.length === 0 && field.kind === 'boolean'}>
          <SettingsSegmented
            label={tr('Value')}
            value={
              value()?.kind === 'boolean' ? String((value() as { value: boolean }).value) : null
            }
            disabled={owner.disabled()}
            choices={[
              { value: 'false', title: tr('Off') },
              { value: 'true', title: tr('On') },
            ]}
            change={(choice) => change({ kind: 'boolean', value: choice === 'true' })}
          />
        </If>
        <If when={field.nullable}>{special({ kind: 'null' }, tr('Set null'))}</If>
        <If when={!field.required}>{special(null, tr('Remove explicit value'))}</If>
      </SettingsSection>
    </SettingsBody>
  );
}
