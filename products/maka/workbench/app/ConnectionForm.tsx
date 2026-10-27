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

import { inputAction, Scroll, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { ModelSettingsOwner } from './settings';
import { SettingsField } from './SettingsField';
import { ConnectionLogin } from './ConnectionLogin';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

export function ConnectionForm(props: { settings: ModelSettingsOwner }) {
  const owner = props.settings;
  const form = () => owner.editor()!;
  const disabled = () =>
    owner.busy() || owner.loading() || !owner.pendingKnown() || owner.pending().length > 0;
  const models = () => form().baseline?.editing?.enabledModelIds ?? [];
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ padding: 8, gap: 16 }}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {form().provider.descriptor.label}
        </Text>
        <SettingsField
          label={tr('Connection name')}
          value={form().name}
          change={(text) => owner.edit('name', text)}
          disabled={disabled()}
        />
        <SettingsField
          label={tr('Connection ID')}
          value={form().slug}
          change={(text) => owner.edit('slug', text)}
          disabled={disabled()}
          readonly={!!form().baseline}
          hint={tr(
            'A unique lowercase name, such as openrouter-work. It stays fixed after creation.',
          )}
        />
        <If when={owner.editableBaseUrl()}>
          <SettingsField
            label={tr('Base URL')}
            value={form().baseUrl}
            change={(text) => owner.edit('baseUrl', text)}
            disabled={disabled()}
            hint={tr('Use the API endpoint supplied by your provider.')}
          />
        </If>
        <Button
          disabled={disabled()}
          selected={form().enabled}
          accessibilityLabel={tr('Enable connection')}
          onPress={inputAction(owner.toggleEnabled, {
            ...owner.action(),
            enabled: !form().enabled,
          })}
          style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 12 }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>
            {tr('Connection enabled')}
          </Text>
          <ChoiceIndicator kind="switch" checked={form().enabled} disabled={disabled()} />
        </Button>
        <If
          when={form().provider.descriptor.authentication.some(
            (method) => method.id === 'api-key' && !method.interactive,
          )}
        >
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
        <ConnectionLogin owner={owner} disabled={disabled()} />
        <If when={owner.credential()?.configured}>
          <Button
            disabled={disabled() || owner.dirty()}
            accessibilityLabel={tr('Remove stored provider credential')}
            onPress={inputAction(owner.confirm, {
              ...owner.action(),
              kind: 'key',
              modelId: null,
            })}
            style={controlStyle}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.danger }}>
              {tr('Remove stored provider credential')}
            </Text>
          </Button>
          <If when={owner.dirty()}>
            <Text style={{ ...bodyTextStyle, color: C.muted }}>
              {tr('Save or discard connection edits before removing the stored credential.')}
            </Text>
          </If>
        </If>
        <SettingsField
          label={tr('Advanced request JSON')}
          value={form().overlay}
          multiline
          change={(text) => owner.edit('overlay', text)}
          disabled={disabled()}
          hint={tr(
            'Merged into model requests. For OpenRouter: {"provider":{"only":["openrouter","deepseek"]}}. Use null to clear.',
          )}
        />
        <Button
          disabled={disabled()}
          accessibilityLabel={tr('Save connection')}
          onPress={inputAction(owner.saveConnection, owner.action())}
          style={{ ...controlStyle, alignSelf: 'flex-start', backgroundColor: C.accent }}
          hoverStyle={{ backgroundColor: C.accentHover }}
          focusStyle={{ backgroundColor: C.accentHover }}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.background, fontWeight: '500' }}>
            {owner.discovery() === 'fetching'
              ? tr('Fetching models…')
              : owner.busy()
                ? tr('Saving…')
                : tr('Save connection')}
          </Text>
        </Button>
        <If when={form().baseline}>
          <View style={{ height: 1, backgroundColor: C.line }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <Text style={{ ...bodyTextStyle, color: C.text, flex: 1, fontWeight: '500' }}>
              {tr('Models · {count}', { count: models().length })}
            </Text>
            <Button
              disabled={disabled() || owner.dirty()}
              accessibilityLabel={tr('Add model manually')}
              onPress={inputAction(owner.editModel, { ...owner.action(), id: null })}
              style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="plus" color={C.accent} />
              <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Add model')}</Text>
            </Button>
            <If when={form().provider.descriptor.discovery}>
              <Button
                disabled={disabled() || owner.dirty()}
                accessibilityLabel={tr('Fetch models')}
                onPress={inputAction(owner.discover, owner.action())}
                style={controlStyle}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={{ ...captionTextStyle, color: C.accent }}>
                  {owner.discovery() === 'fetching'
                    ? tr('Fetching models…')
                    : owner.discovery() === 'failed'
                      ? tr('Retry fetching models')
                      : tr('Fetch models')}
                </Text>
              </Button>
            </If>
          </View>
          <If when={owner.discovery() === 'fetching'}>
            <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Fetching models…')}</Text>
          </If>
          <If when={owner.discovery() === 'failed'}>
            <Text style={{ ...bodyTextStyle, color: C.danger }}>
              {tr(
                'Model fetch failed. The connection remains saved. Retry fetching models or add a model manually.',
              )}
            </Text>
          </If>
          <If when={owner.discovery() === 'ready'}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {tr('Models fetched and enabled.')}
            </Text>
          </If>
          <If when={!models().length}>
            <Text style={{ ...bodyTextStyle, color: C.muted }}>
              {tr('Fetch the provider’s catalog or add its exact model ID.')}
            </Text>
          </If>
          <Button
            disabled={disabled() || owner.dirty()}
            accessibilityLabel={tr('Manage models')}
            onPress={inputAction(owner.showModels, owner.action())}
            style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.accent, flex: 1 }}>
              {tr('Manage models · {count}', { count: models().length })}
            </Text>
            <Icon name="right" color={C.muted} />
          </Button>
          <If when={owner.dirty()}>
            <Text style={{ ...bodyTextStyle, color: C.muted }}>
              {tr('Save changes before fetching or editing models.')}
            </Text>
          </If>
          <If when={owner.defaultTarget()?.connectionId === form().baseline?.target.connectionId}>
            <Button
              disabled={disabled()}
              onPress={inputAction(owner.setDefault, { ...owner.action(), id: null })}
              style={controlStyle}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Clear default model')}
              </Text>
            </Button>
          </If>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button
              disabled={disabled()}
              onPress={inputAction(owner.openConnection, {
                connectionId: form().baseline!.target.connectionId,
                revision: form().baseline!.target.revision,
              })}
              style={controlStyle}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Discard changes and reload')}
              </Text>
            </Button>
            <Button
              disabled={disabled()}
              onPress={inputAction(owner.confirm, {
                ...owner.action(),
                kind: 'connection',
                modelId: null,
              })}
              style={controlStyle}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.danger }}>
                {tr('Delete connection')}
              </Text>
            </Button>
          </View>
        </If>
      </View>
    </Scroll>
  );
}
