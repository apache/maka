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

import { inputAction, platform, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { ModelSettingsOwner } from './settings';
import { SettingsField } from './SettingsField';
import { ConnectionLogin } from './ConnectionLogin';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  C,
  Disclosure,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

export function ConnectionForm(props: { settings: ModelSettingsOwner }) {
  const owner = props.settings;
  const advanced = signal(false);
  const form = () => owner.editor()!;
  const disabled = () =>
    owner.busy() || owner.loading() || !owner.pendingKnown() || owner.pending().length > 0;
  const models = () => form().baseline?.editing?.enabledModelIds ?? [];
  const interactive = () =>
    form().provider.descriptor.authentication.some((method) => method.interactive);
  const keyed = () =>
    form().provider.descriptor.authentication.some(
      (method) => method.id === 'api-key' && !method.interactive,
    );
  const canDiscover = () =>
    !disabled() &&
    !owner.dirty() &&
    (form().provider.descriptor.anonymous || !!owner.credential()?.configured);
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <Scroll
        style={{ flex: 1, minHeight: 0 }}
        contentStyle={{ paddingRight: platform.isTerminal ? 0 : 8 }}
      >
        <View style={{ paddingVertical: 16, gap: 24 }}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {form().provider.descriptor.label}
          </Text>
          <ConnectionLogin owner={owner} disabled={disabled()} />
          <If when={keyed()}>
            <SettingsField
              label={tr('API key')}
              value={form().apiKey}
              masked
              change={(text) => owner.edit('apiKey', text)}
              disabled={disabled()}
              hint={
                owner.credential()?.configured
                  ? tr(
                      'A provider credential is stored. Leave blank to keep it; enter a key to replace it.',
                    )
                  : tr('Your key is stored securely and is never displayed again.')
              }
            />
          </If>
          <View style={{ gap: 16 }}>
            <If when={form().provider.descriptor.customEndpoint}>
              <SettingsField
                label={tr('Base URL')}
                value={form().baseUrl}
                change={(text) => owner.edit('baseUrl', text)}
                disabled={disabled()}
              />
            </If>
            <SettingsField
              label={tr('Connection name')}
              value={form().name}
              change={(text) => owner.edit('name', text)}
              disabled={disabled()}
            />
            <Button
              disabled={disabled()}
              selected={form().enabled}
              accessibilityLabel={tr('Enable connection')}
              onPress={inputAction(owner.toggleEnabled, {
                ...owner.action(),
                enabled: !form().enabled,
              })}
              style={{
                ...controlStyle,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 0,
              }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              activeStyle={{ backgroundColor: C.raised }}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>
                {tr('Connection enabled')}
              </Text>
              <ChoiceIndicator kind="switch" checked={form().enabled} disabled={disabled()} />
            </Button>
          </View>
          <If when={form().baseline}>
            <View style={{ gap: 12 }}>
              <View
                style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}
              >
                <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500', flex: 1 }}>
                  {tr('Models · {count}', { count: models().length })}
                </Text>
                <If when={form().provider.descriptor.discovery}>
                  <Button
                    accessibilityLabel={tr('Fetch models')}
                    disabled={!canDiscover()}
                    onPress={inputAction(owner.discover, owner.action())}
                    style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                    activeStyle={{ backgroundColor: C.raised }}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Icon name="refresh" color={C.secondary} />
                    <Text style={{ ...captionTextStyle, color: C.secondary }}>
                      {owner.discovery() === 'fetching'
                        ? tr('Fetching models…')
                        : owner.discovery() === 'failed'
                          ? tr('Retry fetching models')
                          : tr('Fetch models')}
                    </Text>
                  </Button>
                </If>
              </View>
              <If when={models().length > 0}>
                <Button
                  accessibilityLabel={tr('Manage models')}
                  disabled={disabled() || owner.dirty()}
                  onPress={inputAction(owner.showModels, owner.action())}
                  style={{
                    ...controlStyle,
                    minHeight: 40,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    backgroundColor: C.background,
                  }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  activeStyle={{ backgroundColor: C.raised }}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text
                    style={[{ ...captionTextStyle, color: C.text, flex: 1 }, { numberOfLines: 1 }]}
                  >
                    {models()
                      .slice(0, 3)
                      .map(
                        (id) => form().baseline?.editing?.modelOverrides?.[id]?.displayName ?? id,
                      )
                      .join(', ')}
                  </Text>
                  <Icon name="right" color={C.muted} />
                </Button>
              </If>
              <If when={!models().length}>
                <Text style={{ ...captionTextStyle, color: C.muted }}>
                  {tr('No models added yet.')}
                </Text>
              </If>
              <Button
                accessibilityLabel={tr('Add model manually')}
                disabled={disabled() || owner.dirty()}
                onPress={inputAction(owner.editModel, { ...owner.action(), id: null })}
                style={{
                  ...controlStyle,
                  alignSelf: 'flex-start',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                activeStyle={{ backgroundColor: C.raised }}
                disabledStyle={controlDisabledStyle}
              >
                <Icon name="plus" color={C.secondary} />
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {tr('Add model manually')}
                </Text>
              </Button>
            </View>
          </If>
          <View style={{ gap: 16 }}>
            <Disclosure
              label={tr('Advanced connection settings')}
              open={advanced()}
              onPress={() => advanced.set(!advanced())}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Advanced')}</Text>
            </Disclosure>
            <If when={advanced()}>
              <SettingsField
                label={tr('Connection ID')}
                value={form().slug}
                change={(text) => owner.edit('slug', text)}
                disabled={disabled()}
                readonly={!!form().baseline}
                hint={
                  form().baseline
                    ? undefined
                    : tr(
                        'A unique lowercase name, such as openrouter-work. It stays fixed after creation.',
                      )
                }
              />
              <If when={owner.editableBaseUrl() && !form().provider.descriptor.customEndpoint}>
                <SettingsField
                  label={tr('Base URL')}
                  value={form().baseUrl}
                  change={(text) => owner.edit('baseUrl', text)}
                  disabled={disabled()}
                />
              </If>
              <SettingsField
                label={tr('Advanced request JSON')}
                value={form().overlay}
                multiline
                change={(text) => owner.edit('overlay', text)}
                disabled={disabled()}
                hint={tr('Merged into model requests. Use null to clear.')}
              />
              <If when={owner.credential()?.configured}>
                <Button
                  accessibilityLabel={tr('Remove stored provider credential')}
                  disabled={disabled() || owner.dirty()}
                  onPress={inputAction(owner.confirm, {
                    ...owner.action(),
                    kind: 'key',
                    modelId: null,
                  })}
                  style={{ ...controlStyle, alignSelf: 'flex-start' }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  activeStyle={{ backgroundColor: C.raised }}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text style={{ ...captionTextStyle, color: C.danger }}>
                    {interactive() ? tr('Sign out') : tr('Remove stored provider credential')}
                  </Text>
                </Button>
              </If>
              <If
                when={owner.defaultTarget()?.connectionId === form().baseline?.target.connectionId}
              >
                <Button
                  disabled={disabled()}
                  onPress={inputAction(owner.setDefault, { ...owner.action(), id: null })}
                  style={{ ...controlStyle, alignSelf: 'flex-start' }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  activeStyle={{ backgroundColor: C.raised }}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text style={{ ...captionTextStyle, color: C.secondary }}>
                    {tr('Clear default selection')}
                  </Text>
                </Button>
              </If>
            </If>
          </View>
        </View>
      </Scroll>
      <View
        style={{
          paddingVertical: 16,
          paddingRight: platform.isTerminal ? 0 : 8,
          borderTopWidth: 1,
          borderTopColor: C.line,
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <If when={form().baseline}>
          <Button
            accessibilityLabel={tr('Delete connection')}
            disabled={disabled()}
            onPress={inputAction(owner.confirm, {
              ...owner.action(),
              kind: 'connection',
              modelId: null,
            })}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            activeStyle={{ backgroundColor: C.raised }}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.danger }}>{tr('Delete connection')}</Text>
          </Button>
        </If>
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <If when={form().baseline}>
            <Button
              accessibilityLabel={tr('Reload connection')}
              disabled={disabled()}
              onPress={inputAction(owner.reloadConnection, owner.action())}
              style={controlStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              activeStyle={{ backgroundColor: C.raised }}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {owner.dirty() ? tr('Discard changes and reload') : tr('Reload connection')}
              </Text>
            </Button>
          </If>
          <Button
            accessibilityLabel={tr('Save connection')}
            disabled={disabled() || !owner.dirty()}
            onPress={inputAction(owner.saveConnection, owner.action())}
            style={{
              ...controlStyle,
              minWidth: 104,
              backgroundColor: C.accent,
              alignItems: 'center',
            }}
            hoverStyle={{ backgroundColor: C.accentHover }}
            focusStyle={{ backgroundColor: C.accentHover }}
            activeStyle={{ backgroundColor: C.accentHover }}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.background, fontWeight: '500' }}>
              {owner.busy() && !owner.login.state() && owner.discovery() !== 'fetching'
                ? tr('Saving…')
                : tr('Save connection')}
            </Text>
          </Button>
        </View>
      </View>
    </View>
  );
}
