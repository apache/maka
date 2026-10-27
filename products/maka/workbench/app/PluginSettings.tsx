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

import { inputAction, List, Scroll, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { Button } from 'nsh/base';
import { tr } from './locale';
import type {
  ManagedInstance,
  SettingField,
  SettingValue,
} from '../../../../packages/plugin-sdk/src/index.js';
import { sameValue } from '../../../../plugins/shared/value';
import { pluginTitle, settingCaption } from './pluginSettings.ts';
import type { PluginSettingsOwner, PluginAction } from './pluginSettings.ts';
import { SettingsField } from './SettingsField';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import {
  bodyTextStyle,
  captionTextStyle,
  inputTextStyle,
  inputBorderRadius,
  C,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

export function PluginSettings(props: { owner: PluginSettingsOwner }) {
  const owner = props.owner;
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <Button
        disabled={owner.loading() || owner.busy()}
        accessibilityLabel={tr('Refresh plugin configuration')}
        onPress={inputAction(owner.reload, owner.action())}
        style={{ ...controlStyle, alignSelf: 'flex-start' }}
        hoverStyle={controlHoverStyle()}
        focusStyle={controlFocusStyle()}
        disabledStyle={controlDisabledStyle}
      >
        <Text style={{ ...bodyTextStyle, color: C.secondary }}>
          {owner.editor() ? tr('Discard edit and refresh plugins') : tr('Refresh plugins')}
        </Text>
      </Button>
      <If when={owner.loading()}>
        <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Reading plugins…')}</Text>
      </If>
      <If when={!owner.loading() && !owner.inventory()}>
        <Text style={{ ...bodyTextStyle, color: C.warning }}>
          {tr('Plugin settings are unavailable on this connection.')}
        </Text>
      </If>
      <If when={owner.inventory()}>
        <Each of={[owner.navigation()]} key={(identity) => identity}>
          {() => {
            const request = owner.action();
            return (
              <View style={{ flex: 1, minHeight: 0 }}>
                <If when={!owner.selected()}>
                  <View style={{ flex: 1, minHeight: 0, padding: 8, gap: 12 }}>
                    <Text style={{ ...captionTextStyle, color: C.muted }}>
                      {tr(
                        'Manage plugins for this connection. Your conversation and draft stay open.',
                      )}
                    </Text>
                    <Input
                      accessibilityLabel={tr('Search Host plugins')}
                      value={owner.query()}
                      onChange={(value) => owner.query.set(value)}
                      placeholder={tr('Search plugins…')}
                      style={{
                        ...inputTextStyle,
                        color: C.text,
                        placeholderColor: C.muted,
                        backgroundColor: C.background,
                        height: 40,
                        paddingHorizontal: 12,
                        borderRadius: inputBorderRadius,
                      }}
                    />
                    <List
                      each={owner.filtered()}
                      keyExtractor={(instance) => JSON.stringify(instance.instance)}
                      estimatedItemSize={56 + 12}
                      separator={() => <View style={{ height: 12 }} />}
                      empty={
                        <Text style={{ ...bodyTextStyle, color: C.muted }}>
                          {tr('No matching plugins.')}
                        </Text>
                      }
                      style={{ flex: 1, minHeight: 0 }}
                    >
                      {(item) => (
                        <Each<ManagedInstance>
                          of={[item()]}
                          key={(instance) => JSON.stringify(instance.instance)}
                        >
                          {(row) => {
                            const instance = row();
                            return (
                              <Button
                                disabled={owner.disabled()}
                                accessibilityLabel={tr('Open plugin {name}', {
                                  name: instance.path.join(' / '),
                                })}
                                onPress={inputAction(owner.open, {
                                  request,
                                  instance: instance.instance,
                                })}
                                style={{
                                  ...controlStyle,
                                  minHeight: 56,
                                  flexDirection: 'row',
                                  alignItems: 'center',
                                  gap: 12,
                                  backgroundColor: C.raised,
                                }}
                                hoverStyle={controlHoverStyle()}
                                focusStyle={controlFocusStyle()}
                                disabledStyle={controlDisabledStyle}
                              >
                                <View
                                  style={[
                                    { flex: 1, minWidth: 0, gap: 4 },
                                    { pointerEvents: 'none' },
                                  ]}
                                >
                                  <Text style={{ ...bodyTextStyle, color: C.text }}>
                                    {pluginTitle(instance)}
                                  </Text>
                                  <Text style={{ ...captionTextStyle, color: C.muted }}>
                                    {instance.path.join(' / ')} ·{' '}
                                    {instance.disabled ? tr('Disabled') : tr('Enabled')}
                                    {instance.parentDisabled ? ` · ${tr('Parent disabled')}` : ''}
                                  </Text>
                                </View>
                                <Icon name="right" color={C.muted} />
                              </Button>
                            );
                          }}
                        </Each>
                      )}
                    </List>
                  </View>
                </If>
                <If when={owner.selected()}>
                  <Scroll style={{ flex: 1, minHeight: 0 }}>
                    <View style={{ padding: 8, gap: 12 }}>
                      <If when={owner.editor()}>
                        <PluginField owner={owner} request={request} />
                      </If>
                      <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>
                        {pluginTitle(owner.selected()!)}
                      </Text>
                      <Text
                        style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'text' }]}
                      >
                        {owner.selected()!.path.join(' / ')}
                      </Text>
                      <Text
                        style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'text' }]}
                      >
                        {owner.selected()!.package.id} · {owner.selected()!.package.revision}
                      </Text>
                      <Text style={[{ ...bodyTextStyle, color: C.muted }, { numberOfLines: 3 }]}>
                        {owner.selected()!.presentation?.description}
                      </Text>
                      <Text style={{ ...captionTextStyle, color: C.muted }}>
                        {tr(
                          'Saved configuration · revision {revision}. Enabled shows the saved setting. Changes may take a moment to apply.',
                          { revision: owner.inventory()!.source.revision },
                        )}
                      </Text>
                      <If when={!owner.editor()}>
                        <Button
                          disabled={
                            owner.disabled() ||
                            (owner.selected()!.disabled && owner.selected()!.parentDisabled)
                          }
                          accessibilityLabel={
                            owner.selected()!.disabled
                              ? tr('Enable Host plugin')
                              : tr('Disable Host plugin')
                          }
                          onPress={inputAction(owner.toggle, {
                            request,
                            enabled: owner.selected()!.disabled,
                          })}
                          style={{
                            ...controlStyle,
                            minHeight: 40,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 12,
                          }}
                          hoverStyle={controlHoverStyle()}
                          focusStyle={controlFocusStyle()}
                          disabledStyle={controlDisabledStyle}
                        >
                          <Text style={{ ...bodyTextStyle, color: C.text, flex: 1 }}>
                            {tr('Enabled')}
                          </Text>
                          <ChoiceIndicator
                            kind="switch"
                            checked={!owner.selected()!.disabled}
                            disabled={
                              owner.disabled() ||
                              (owner.selected()!.disabled && owner.selected()!.parentDisabled)
                            }
                          />
                        </Button>
                        <If when={owner.selected()!.parentDisabled}>
                          <Text style={{ ...bodyTextStyle, color: C.warning }}>
                            {tr('Enable the parent plugin before enabling this child.')}
                          </Text>
                        </If>
                        <If when={owner.selected()!.structural}>
                          <Text style={{ ...captionTextStyle, color: C.muted }}>
                            {tr('Open a plugin in this group to edit its settings.')}
                          </Text>
                        </If>
                        <If when={owner.fields()}>
                          <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>
                            {tr('Configuration')}
                            {owner.fields()!.path.length
                              ? ` / ${owner.fields()!.path.join(' / ')}`
                              : ''}
                          </Text>
                          <List
                            viewport="parent"
                            each={owner.fields()!.fields}
                            keyExtractor={(field) => field.key}
                            estimatedItemSize={56 + 12}
                            separator={() => <View style={{ height: 12 }} />}
                            onLoadMore={() => void owner.loadMore(request)}
                          >
                            {(item) => (
                              <Each<SettingField> of={[item()]} key={(field) => field.key}>
                                {(row) => {
                                  const field = row();
                                  const group = ['object', 'array'].includes(field.kind);
                                  return (
                                    <Button
                                      disabled={owner.disabled() || !field.editable}
                                      accessibilityLabel={
                                        group
                                          ? tr('Open plugin group {name}', { name: field.label })
                                          : tr('Edit plugin setting {name}', {
                                              name: field.label,
                                            })
                                      }
                                      onPress={
                                        group
                                          ? inputAction(owner.group, { request, key: field.key })
                                          : inputAction(owner.edit, { request, key: field.key })
                                      }
                                      style={{
                                        ...controlStyle,
                                        minHeight: 56,
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 12,
                                        backgroundColor: C.raised,
                                      }}
                                      hoverStyle={controlHoverStyle()}
                                      focusStyle={controlFocusStyle()}
                                      disabledStyle={controlDisabledStyle}
                                    >
                                      <View
                                        style={[
                                          { flex: 1, minWidth: 0, gap: 4 },
                                          { pointerEvents: 'none' },
                                        ]}
                                      >
                                        <Text style={{ ...bodyTextStyle, color: C.text }}>
                                          {field.label}
                                        </Text>
                                        <Text
                                          style={[
                                            { ...captionTextStyle, color: C.muted },
                                            { numberOfLines: 2 },
                                          ]}
                                        >
                                          {group
                                            ? field.kind === 'array'
                                              ? tr('List')
                                              : tr('Group')
                                            : field.editable
                                              ? settingCaption(field.value)
                                              : tr('Read only or private')}
                                        </Text>
                                      </View>
                                      <Icon name="right" color={C.muted} />
                                    </Button>
                                  );
                                }}
                              </Each>
                            )}
                          </List>
                          <If when={!owner.fields()!.fields.length}>
                            <Text style={{ ...bodyTextStyle, color: C.muted }}>
                              {tr('No editable fields in this group.')}
                            </Text>
                          </If>
                        </If>
                      </If>
                    </View>
                  </Scroll>
                </If>
              </View>
            );
          }}
        </Each>
      </If>
    </View>
  );
}

function PluginField(props: { owner: PluginSettingsOwner; request: PluginAction }) {
  const owner = props.owner,
    request = props.request;
  const field = owner.editor()!.field;
  const value = () => owner.editor()?.value ?? null;
  const change = (next: SettingValue | null) => owner.change({ request, value: next });
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>{field.label}</Text>
      <If when={field.description}>
        <Text style={{ ...bodyTextStyle, color: C.muted }}>{field.description}</Text>
      </If>
      <If when={field.options.length > 0}>
        <List
          viewport="parent"
          each={field.options}
          keyExtractor={(choice) => JSON.stringify(choice)}
          initialScrollIndex={Math.max(
            0,
            field.options.findIndex((choice) => sameValue(choice, value())),
          )}
          estimatedItemSize={40 + 12}
          separator={() => <View style={{ height: 12 }} />}
        >
          {(item) => (
            <Each<SettingValue> of={[item()]} key={(choice) => JSON.stringify(choice)}>
              {(row) => {
                const choice = row();
                return (
                  <Button
                    disabled={owner.disabled()}
                    selected={sameValue(value(), choice)}
                    accessibilityLabel={tr('Choose plugin setting {value}', {
                      value: settingCaption(choice),
                    })}
                    onPress={inputAction(owner.change, { request, value: choice })}
                    style={{
                      ...controlStyle,
                      minHeight: 40,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                    selectedStyle={{ backgroundColor: C.raised }}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <ChoiceIndicator
                      kind="radio"
                      checked={sameValue(value(), choice)}
                      disabled={owner.disabled()}
                    />
                    <Text style={{ ...bodyTextStyle, color: C.text, flex: 1 }}>
                      {settingCaption(choice)}
                    </Text>
                  </Button>
                );
              }}
            </Each>
          )}
        </List>
      </If>
      <If when={field.options.length === 0 && (field.kind === 'text' || field.kind === 'number')}>
        <SettingsField
          autoFocus
          label={tr('Plugin value {name}', { name: field.label })}
          multiline={field.kind === 'text'}
          value={
            value()?.kind === 'text' || value()?.kind === 'number'
              ? (value() as { text: string }).text
              : ''
          }
          disabled={owner.disabled()}
          change={(text) =>
            change(field.kind === 'number' ? { kind: 'number', text } : { kind: 'text', text })
          }
          hint={
            field.kind === 'number'
              ? tr('Enter a number. Decimal text is kept exactly.')
              : undefined
          }
        />
      </If>
      <If when={field.options.length === 0 && field.kind === 'boolean'}>
        <Each of={[false, true]}>
          {(choice) => (
            <Button
              disabled={owner.disabled()}
              selected={
                value()?.kind === 'boolean' && (value() as { value: boolean }).value === choice()
              }
              onPress={inputAction(owner.change, {
                request,
                value: { kind: 'boolean', value: choice() },
              })}
              style={{
                ...controlStyle,
                minHeight: 40,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
              selectedStyle={{ backgroundColor: C.raised }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <ChoiceIndicator
                kind="radio"
                checked={
                  value()?.kind === 'boolean' && (value() as { value: boolean }).value === choice()
                }
                disabled={owner.disabled()}
              />
              <Text style={{ ...bodyTextStyle, color: C.text }}>
                {choice() ? tr('On') : tr('Off')}
              </Text>
            </Button>
          )}
        </Each>
      </If>
      <If when={field.nullable}>
        <Button
          disabled={owner.disabled()}
          selected={value()?.kind === 'null'}
          onPress={inputAction(owner.change, { request, value: { kind: 'null' } })}
          style={{
            ...controlStyle,
            minHeight: 40,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
          selectedStyle={{ backgroundColor: C.raised }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <ChoiceIndicator
            kind="radio"
            checked={value()?.kind === 'null'}
            disabled={owner.disabled()}
          />
          <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('Set null')}</Text>
        </Button>
      </If>
      <If when={!field.required}>
        <Button
          disabled={owner.disabled()}
          selected={value() === null}
          onPress={inputAction(owner.change, { request, value: null })}
          style={{
            ...controlStyle,
            minHeight: 40,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
          selectedStyle={{ backgroundColor: C.raised }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <ChoiceIndicator kind="radio" checked={value() === null} disabled={owner.disabled()} />
          <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('Remove explicit value')}</Text>
        </Button>
      </If>
      <Button
        disabled={owner.disabled()}
        accessibilityLabel={tr('Save Host plugin setting')}
        onPress={inputAction(owner.save, { request, value: value() })}
        style={{ ...controlStyle, alignSelf: 'flex-start', backgroundColor: C.accent }}
        hoverStyle={{ backgroundColor: C.accentHover }}
        focusStyle={{ backgroundColor: C.accentHover }}
        disabledStyle={controlDisabledStyle}
      >
        <Text style={{ ...bodyTextStyle, color: C.background, fontWeight: '500' }}>
          {tr('Save plugin setting')}
        </Text>
      </Button>
    </View>
  );
}
