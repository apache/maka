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
import type { McpSettingsOwner, McpEditor } from './mcpSettingsState';
import { mcpLaunch, mcpDisabled } from './mcpSettingsState';
import { ConfigurationScope, LocationChoices } from './ConfigurationScope';
import { tr } from './locale';
import {
  SettingsBody,
  SettingsButton,
  SettingsConfirm,
  SettingsFields,
  SettingsFormFooter,
  SettingsInlineInput,
  SettingsInput,
  SettingsRow,
  SettingsSearch,
  SettingsSection,
  SettingsSegmented,
  SettingsSwitch,
  SettingsTextArea,
} from './SettingsPage';

export function McpSettings(props: { owner: McpSettingsOwner }) {
  const owner = props.owner;
  return (
    <If when={!owner.deleting()} else={<Removal owner={owner} />}>
      <If when={owner.editor()} else={<ServerList owner={owner} />}>
        <ServerEditor owner={owner} />
      </If>
    </If>
  );
}

function ServerList(props: { owner: McpSettingsOwner }) {
  const owner = props.owner;
  const disabled = () => owner.busy() || owner.loading();
  return (
    <SettingsBody>
      <SettingsSection>
        <ConfigurationScope owner={owner.scope} />
      </SettingsSection>
      <If when={owner.rows().length > 8 || owner.query().trim()}>
        <SettingsSearch
          label={tr('Search MCP servers')}
          value={owner.query()}
          change={(value) => owner.query.set(value)}
        />
      </If>
      <If when={owner.loading() && !owner.inventory()}>
        <LoadingIndicator />
      </If>
      <If when={owner.inventory()}>
        <SettingsSection title={tr('MCP servers')}>
          <Each of={owner.rows()} key={(row) => `${row.location.location}:${row.entry.name}`}>
            {(row) => (
              <SettingsRow
                label={row().entry.name}
                tone={
                  row().entry.shadowedBy || mcpDisabled(row().entry.configuration)
                    ? 'muted'
                    : undefined
                }
                description={[
                  row().entry.shadowedBy
                    ? tr('Overridden')
                    : mcpDisabled(row().entry.configuration)
                      ? tr('Disabled')
                      : null,
                  mcpLaunch(row().entry.configuration),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                accessibilityLabel={tr('Edit MCP server {name} at {path}', {
                  name: row().entry.name,
                  path: row().location.path,
                })}
                opens
                disabled={disabled()}
                onPress={() => owner.open(row())}
              />
            )}
          </Each>
          <If when={!owner.rows().length}>
            <SettingsRow label={tr('No MCP servers found.')} tone="muted" />
          </If>
        </SettingsSection>
      </If>
    </SettingsBody>
  );
}

function ServerEditor(props: { owner: McpSettingsOwner }) {
  const owner = props.owner;
  const editor = () => owner.editor()!;
  const disabled = () => owner.busy() || owner.loading();
  const path = () =>
    owner.inventory()?.locations.find((location) => location.location === editor().location)?.path;
  const original = () =>
    owner
      .rows()
      .find(
        (row) =>
          row.entry.name === editor().original && row.location.location === editor().location,
      );
  return (
    <SettingsBody
      footer={
        <SettingsFormFooter
          saveLabel={tr('Save MCP server')}
          canSave={
            !disabled() &&
            !!editor().name.trim() &&
            (!editor().enabled ||
              !!(editor().transport === 'stdio' ? editor().command : editor().url))
          }
          busy={owner.busy()}
          save={() => owner.save(editor())}
          cancel={() => owner.back()}
        />
      }
    >
      <SettingsSection>
        <If
          when={editor().original}
          else={
            <LocationChoices
              targets={owner.inventory()?.locations ?? []}
              selected={editor().location}
              choose={(location) => owner.change('location', location)}
              disabled={disabled()}
            />
          }
        >
          <SettingsRow label={tr('Configuration location')} description={path()} />
        </If>
        <SettingsInput
          label={tr('Server name')}
          value={editor().name}
          change={(value) => owner.change('name', value)}
          readonly={!!editor().original}
          disabled={disabled()}
          autoFocus={!editor().original}
        />
        <SettingsSegmented
          label={tr('Transport')}
          value={editor().transport}
          choices={[
            { value: 'stdio', title: tr('Local command') },
            { value: 'http', title: 'Streamable HTTP' },
          ]}
          disabled={disabled()}
          change={(value) => owner.change('transport', value as McpEditor['transport'])}
        />
        <If when={editor().transport === 'stdio'}>
          <SettingsInput
            label={tr('Command')}
            value={editor().command}
            change={(value) => owner.change('command', value)}
            placeholder="npx"
            disabled={disabled()}
          />
        </If>
        <If when={editor().transport === 'http'}>
          <SettingsInput
            label={tr('Server URL')}
            value={editor().url}
            change={(value) => owner.change('url', value)}
            placeholder="https://example.com/mcp"
            disabled={disabled()}
          />
        </If>
        <SettingsSwitch
          label={tr('Enabled')}
          checked={editor().enabled}
          disabled={disabled()}
          onPress={() => owner.change('enabled', !editor().enabled)}
        />
      </SettingsSection>
      <If when={editor().transport === 'stdio'}>
        <SettingsSection
          title={tr('Arguments')}
          trailing={
            <SettingsButton
              label={tr('Add argument')}
              tone="quiet"
              icon="plus"
              disabled={disabled()}
              onPress={owner.addArgument}
            />
          }
        >
          <Each of={editor().args} key={(argument) => argument.id}>
            {(argument) => (
              <SettingsFields>
                <SettingsInlineInput
                  label={tr('Argument')}
                  value={argument().value}
                  change={(value) => owner.changeArgument({ id: argument().id, value })}
                  disabled={disabled()}
                />
                <SettingsButton
                  label={tr('Remove argument')}
                  icon="trash"
                  iconOnly
                  tone="quiet"
                  disabled={disabled()}
                  onPress={() => owner.removeArgument(argument().id)}
                />
              </SettingsFields>
            )}
          </Each>
          <If when={!editor().args.length}>
            <SettingsRow label={tr('No arguments.')} tone="muted" />
          </If>
        </SettingsSection>
      </If>
      <SettingsSection>
        <SettingsRow
          label={tr('Advanced options')}
          opens={!editor().advanced}
          disabled={disabled()}
          onPress={() => owner.change('advanced', !editor().advanced)}
        />
      </SettingsSection>
      <If when={editor().advanced}>
        <If when={editor().transport === 'stdio'}>
          <SettingsSection>
            <SettingsInput
              label={tr('Working directory')}
              value={editor().cwd}
              change={(value) => owner.change('cwd', value)}
              disabled={disabled()}
            />
          </SettingsSection>
          <Pairs owner={owner} group="env" label={tr('Environment variables')} />
          <SettingsSection title={tr('Forward Host environment variables (one per line)')}>
            <SettingsTextArea
              label={tr('Forward Host environment variables (one per line)')}
              value={editor().passEnv}
              lines={3}
              monospace
              change={(value) => owner.change('passEnv', value)}
              disabled={disabled()}
            />
          </SettingsSection>
        </If>
        <If when={editor().transport === 'http'}>
          <Pairs owner={owner} group="headers" label={tr('HTTP headers')} />
          <Pairs
            owner={owner}
            group="headerEnv"
            label={tr('Headers from Host environment variables')}
          />
        </If>
      </If>
      <If when={original()}>
        <SettingsSection>
          <SettingsRow
            label={tr('Delete')}
            accessibilityLabel={tr('Delete MCP server {name} at {path}', {
              name: original()!.entry.name,
              path: original()!.location.path,
            })}
            tone="danger"
            disabled={disabled()}
            onPress={() => owner.deleting.set(original()!)}
          />
        </SettingsSection>
      </If>
    </SettingsBody>
  );
}

function Pairs(props: {
  owner: McpSettingsOwner;
  group: 'env' | 'headers' | 'headerEnv';
  label: string;
}) {
  const owner = props.owner;
  return (
    <SettingsSection
      title={props.label}
      trailing={
        <SettingsButton
          label={tr('Add row')}
          tone="quiet"
          icon="plus"
          disabled={owner.busy()}
          onPress={() => owner.addPair(props.group)}
        />
      }
    >
      <Each of={owner.editor()?.[props.group] ?? []} key={(pair) => pair.id}>
        {(pair) => (
          <SettingsFields>
            <SettingsInlineInput
              label={tr('Name')}
              value={pair().name}
              change={(value) =>
                owner.changePair({ group: props.group, id: pair().id, field: 'name', value })
              }
              disabled={owner.busy()}
            />
            <SettingsInlineInput
              label={tr('Value')}
              value={pair().value}
              grow={2}
              masked={props.group !== 'headerEnv'}
              change={(value) =>
                owner.changePair({ group: props.group, id: pair().id, field: 'value', value })
              }
              disabled={owner.busy()}
            />
            <SettingsButton
              label={tr('Remove row')}
              icon="trash"
              iconOnly
              tone="quiet"
              disabled={owner.busy()}
              onPress={() => owner.removePair({ group: props.group, id: pair().id })}
            />
          </SettingsFields>
        )}
      </Each>
      <If when={!(owner.editor()?.[props.group] ?? []).length}>
        <SettingsRow label={tr('None')} tone="muted" />
      </If>
    </SettingsSection>
  );
}

function Removal(props: { owner: McpSettingsOwner }) {
  const owner = props.owner;
  const row = () => owner.deleting()!;
  return (
    <SettingsConfirm
      title={tr('Delete MCP server {name}?', { name: row().entry.name })}
      body={row().location.path}
      confirm={tr('Delete')}
      destructive
      disabled={owner.busy() || owner.loading()}
      onConfirm={() => owner.remove(row())}
      onCancel={() => owner.back()}
    />
  );
}
