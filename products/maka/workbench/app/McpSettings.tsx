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

import { List, Scroll, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import type { McpSettingsOwner, McpEditor } from './mcpSettingsState';
import { mcpLaunch, mcpDisabled } from './mcpSettingsState';
import { ConfigurationScope, LocationChoices, ManageButton } from './ConfigurationScope';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import { SettingsField } from './SettingsField';
import { tr } from './locale';
import { C, bodyTextStyle, captionTextStyle, inputTextStyle } from './ui';

function Pairs(props: {
  owner: McpSettingsOwner;
  group: 'env' | 'headers' | 'headerEnv';
  label: string;
}) {
  const owner = props.owner;
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ ...bodyTextStyle, color: C.secondary }}>{props.label}</Text>
      <Each of={owner.editor()?.[props.group] ?? []} key={(pair) => pair.id}>
        {(pair) => (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <SettingsField
                label={tr('Name')}
                value={pair().name}
                change={(value) =>
                  owner.changePair({ group: props.group, id: pair().id, field: 'name', value })
                }
                disabled={owner.busy()}
              />
            </View>
            <View style={{ flex: 2, minWidth: 0 }}>
              <SettingsField
                label={tr('Value')}
                value={pair().value}
                change={(value) =>
                  owner.changePair({ group: props.group, id: pair().id, field: 'value', value })
                }
                masked={props.group !== 'headerEnv'}
                disabled={owner.busy()}
              />
            </View>
            <ManageButton
              label={tr('Remove row')}
              action={owner.removePair}
              argument={{ group: props.group, id: pair().id }}
              disabled={owner.busy()}
            >
              <Icon name="trash" color={C.secondary} />
            </ManageButton>
          </View>
        )}
      </Each>
      <ManageButton
        label={tr('Add row')}
        action={owner.addPair}
        argument={props.group}
        disabled={owner.busy()}
      />
    </View>
  );
}
export function McpSettings(props: { owner: McpSettingsOwner }) {
  const owner = props.owner;
  const disabled = () => owner.busy() || owner.loading();
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 12 }}>
      <ConfigurationScope owner={owner.scope} />
      <If when={!owner.editor()}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Input
            accessibilityLabel={tr('Search MCP servers')}
            value={owner.query()}
            onChange={({ value }) => owner.query.set(value)}
            placeholder={tr('Search MCP servers')}
            style={{
              ...inputTextStyle,
              color: C.text,
              backgroundColor: C.background,
              padding: 8,
              flex: 1,
              minWidth: 0,
            }}
          />
          <ManageButton
            label={tr('Refresh')}
            action={owner.refresh}
            argument={null}
            disabled={disabled()}
          />
          <ManageButton
            label={tr('Add MCP server')}
            action={owner.open}
            argument={null}
            disabled={disabled() || !owner.inventory()?.locations.length}
          />
        </View>
        <Each
          of={owner.deleting() ? [owner.deleting()!] : []}
          key={(row) => `${row.location.location}:${row.entry.name}`}
        >
          {(row) => (
            <View
              style={{
                gap: 8,
                padding: 12,
                borderWidth: 1,
                borderColor: C.danger,
                borderRadius: 8,
              }}
            >
              <Text style={{ ...bodyTextStyle, color: C.text }}>
                {tr('Delete MCP server {name}?', { name: row().entry.name })}
              </Text>
              <Text style={{ userSelect: 'text', ...captionTextStyle, color: C.secondary }}>
                {row().location.path}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <ManageButton
                  label={tr('Delete')}
                  danger
                  action={owner.remove}
                  argument={row()}
                  disabled={disabled()}
                />
                <ManageButton
                  label={tr('Cancel')}
                  action={owner.back}
                  argument={null}
                  disabled={owner.busy()}
                />
              </View>
            </View>
          )}
        </Each>
        <List
          each={owner.rows()}
          keyExtractor={(row) => `${row.location.location}:${row.entry.name}`}
          estimatedItemSize={124}
          style={{ flex: 1, minHeight: 0 }}
        >
          {(row) => (
            <View
              style={{
                gap: 8,
                padding: 12,
                marginBottom: 8,
                borderWidth: 1,
                borderColor: C.line,
                borderRadius: 8,
                backgroundColor: C.background,
              }}
            >
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={{ ...bodyTextStyle, fontWeight: '600', color: C.text }}>
                    {row().entry.name}
                  </Text>
                  <Text
                    style={{
                      ...captionTextStyle,
                      color: row().entry.shadowedBy ? C.muted : C.success,
                    }}
                  >
                    {row().entry.shadowedBy
                      ? tr('Overridden')
                      : mcpDisabled(row().entry.configuration)
                        ? tr('Disabled')
                        : tr('Effective')}
                  </Text>
                </View>
                <ManageButton
                  label={tr('Edit')}
                  accessibilityLabel={tr('Edit MCP server {name} at {path}', {
                    name: row().entry.name,
                    path: row().location.path,
                  })}
                  action={owner.open}
                  argument={row()}
                  disabled={disabled()}
                />
                <ManageButton
                  label={tr('Delete MCP server {name} at {path}', {
                    name: row().entry.name,
                    path: row().location.path,
                  })}
                  action={(entry) => owner.deleting.set(entry)}
                  argument={row()}
                  disabled={disabled()}
                >
                  <Icon name="trash" color={C.secondary} />
                </ManageButton>
              </View>
              <Text style={{ userSelect: 'text', ...bodyTextStyle, color: C.secondary }}>
                {mcpLaunch(row().entry.configuration)}
              </Text>
              <Text style={{ userSelect: 'text', ...captionTextStyle, color: C.muted }}>
                {row().location.path}
              </Text>
            </View>
          )}
        </List>
        <If when={!owner.loading() && owner.inventory() && !owner.rows().length}>
          <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('No MCP servers found.')}</Text>
        </If>
      </If>
      <If when={owner.editor()}>
        <Scroll style={{ flex: 1, minHeight: 0 }}>
          <View style={{ gap: 16 }}>
            <If when={!owner.editor()?.original}>
              <Text style={{ ...bodyTextStyle, color: C.text }}>
                {tr('Configuration location')}
              </Text>
              <LocationChoices
                targets={owner.inventory()?.locations ?? []}
                selected={owner.editor()?.location ?? null}
                choose={(location) => owner.change('location', location)}
                disabled={disabled()}
              />
            </If>
            <If when={owner.editor()?.original}>
              <Text style={{ userSelect: 'text', ...captionTextStyle, color: C.muted }}>
                {
                  owner
                    .inventory()
                    ?.locations.find((location) => location.location === owner.editor()?.location)
                    ?.path
                }
              </Text>
            </If>
            <SettingsField
              label={tr('Server name')}
              value={owner.editor()?.name ?? ''}
              change={(value) => owner.change('name', value)}
              readonly={!!owner.editor()?.original}
              disabled={disabled()}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Each of={['stdio', 'http'] as const} key={(transport) => transport}>
                {(transport) => (
                  <ManageButton
                    label={transport() === 'stdio' ? tr('Local command') : 'Streamable HTTP'}
                    action={(value: McpEditor['transport']) => owner.change('transport', value)}
                    argument={transport()}
                    selected={owner.editor()?.transport === transport()}
                    disabled={disabled()}
                  />
                )}
              </Each>
            </View>
            <If when={owner.editor()?.transport === 'stdio'}>
              <SettingsField
                label={tr('Command')}
                value={owner.editor()?.command ?? ''}
                change={(value) => owner.change('command', value)}
                placeholder="npx"
                disabled={disabled()}
              />
              <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Arguments')}</Text>
              <Each of={owner.editor()?.args ?? []} key={(argument) => argument.id}>
                {(argument) => (
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
                    <View style={{ flex: 1 }}>
                      <SettingsField
                        label={tr('Argument')}
                        value={argument().value}
                        change={(value) => owner.changeArgument({ id: argument().id, value })}
                        disabled={disabled()}
                      />
                    </View>
                    <ManageButton
                      label={tr('Remove argument')}
                      action={owner.removeArgument}
                      argument={argument().id}
                      disabled={disabled()}
                    >
                      <Icon name="trash" color={C.secondary} />
                    </ManageButton>
                  </View>
                )}
              </Each>
              <ManageButton
                label={tr('Add argument')}
                action={owner.addArgument}
                argument={null}
                disabled={disabled()}
              />
            </If>
            <If when={owner.editor()?.transport === 'http'}>
              <SettingsField
                label={tr('Server URL')}
                value={owner.editor()?.url ?? ''}
                change={(value) => owner.change('url', value)}
                placeholder="https://example.com/mcp"
                disabled={disabled()}
              />
            </If>
            <ManageButton
              label={tr('Enabled')}
              action={(value: boolean) => owner.change('enabled', value)}
              argument={!owner.editor()?.enabled}
              disabled={disabled()}
            >
              <ChoiceIndicator kind="switch" checked={owner.editor()?.enabled ?? true} />
              <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('Enabled')}</Text>
            </ManageButton>
            <ManageButton
              label={tr('Advanced options')}
              action={(value: boolean) => owner.change('advanced', value)}
              argument={!owner.editor()?.advanced}
              disabled={disabled()}
              selected={owner.editor()?.advanced}
            />
            <If when={owner.editor()?.advanced}>
              <If when={owner.editor()?.transport === 'stdio'}>
                <SettingsField
                  label={tr('Working directory')}
                  value={owner.editor()?.cwd ?? ''}
                  change={(value) => owner.change('cwd', value)}
                  disabled={disabled()}
                />
                <Pairs owner={owner} group="env" label={tr('Environment variables')} />
                <SettingsField
                  label={tr('Forward Host environment variables (one per line)')}
                  value={owner.editor()?.passEnv ?? ''}
                  change={(value) => owner.change('passEnv', value)}
                  multiline
                  disabled={disabled()}
                />
              </If>
              <If when={owner.editor()?.transport === 'http'}>
                <Pairs owner={owner} group="headers" label={tr('HTTP headers')} />
                <Pairs
                  owner={owner}
                  group="headerEnv"
                  label={tr('Headers from Host environment variables')}
                />
              </If>
            </If>
          </View>
        </Scroll>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <ManageButton
            label={tr('Save MCP server')}
            action={owner.save}
            argument={owner.editor()}
            disabled={
              disabled() ||
              !owner.editor()?.name.trim() ||
              (owner.editor()?.enabled &&
                !(owner.editor()?.transport === 'stdio'
                  ? owner.editor()?.command
                  : owner.editor()?.url))
            }
          />
          <ManageButton
            label={tr('Cancel')}
            action={owner.back}
            argument={null}
            disabled={owner.busy()}
          />
        </View>
      </If>
      <If when={owner.loading()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Loading…')}</Text>
      </If>
    </View>
  );
}
