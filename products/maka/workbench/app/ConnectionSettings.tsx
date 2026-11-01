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

import { textTooltip } from './ui';
import { inputAction, Text, View, List } from 'nsh';
import { Input } from 'nsh/base';
import type { ListRef } from 'nsh';
import { Button } from 'nsh/base';
import type { ModelSettingsOwner } from './settings';
import { ConnectionForm } from './ConnectionForm';
import { ProviderPicker } from './ProviderPicker';
import { ConnectionModel } from './ConnectionModel';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  inputTextStyle,
  inputBorderRadius,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

export function ConnectionSettings(props: { owner: ModelSettingsOwner }) {
  const owner = props.owner;
  const unavailable = () => owner.busy() || !owner.pendingKnown() || owner.pending().length > 0;
  const disabled = () => unavailable() || owner.loading();
  const removalLabel = () =>
    owner.confirmation() === 'connection'
      ? tr('Delete connection')
      : owner.confirmation() === 'key'
        ? tr('Remove stored provider credential')
        : tr('Remove model');
  const removalName = () =>
    owner.confirmation() === 'model'
      ? owner.model()?.label.trim() || owner.model()?.originalId || ''
      : owner.editor()?.name || '';
  let connectionsList: ListRef | undefined;
  let modelsList: ListRef | undefined;
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <If when={owner.discardTarget()}>
        <View style={{ gap: 16, paddingVertical: 16 }}>
          <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
            {tr('Discard unsaved changes?')}
          </Text>
          <Text style={{ ...captionTextStyle, color: C.secondary }}>
            {owner.discardTarget() === 'model'
              ? owner.model()?.label || owner.model()?.id
              : owner.editor()?.name}
          </Text>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}
          >
            <Button
              accessibilityLabel={tr('Discard changes')}
              onPress={inputAction(owner.discardEdits, owner.action())}
              style={controlStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              activeStyle={{ backgroundColor: C.line }}
            >
              <Text style={{ ...captionTextStyle, color: C.danger }}>{tr('Discard changes')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('Keep editing')}
              onPress={inputAction(owner.keepEditing, null)}
              style={{ ...controlStyle, backgroundColor: C.accent }}
              hoverStyle={{ backgroundColor: C.accentHover }}
              focusStyle={{ backgroundColor: C.accentHover }}
              activeStyle={{ backgroundColor: C.accentHover }}
            >
              <Text style={{ ...captionTextStyle, color: C.background }}>{tr('Keep editing')}</Text>
            </Button>
          </View>
        </View>
      </If>
      <If when={owner.confirmation()}>
        <View
          style={{
            gap: 16,
            padding: 16,
          }}
        >
          <View style={{ gap: 4 }}>
            <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
              {removalLabel()}
            </Text>
            <Text style={{ ...bodyTextStyle, color: C.text }}>{removalName()}</Text>
            <If
              when={owner.confirmation() === 'model' && removalName() !== owner.model()?.originalId}
            >
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {owner.model()?.originalId}
              </Text>
            </If>
          </View>
          <Text style={{ ...captionTextStyle, color: C.secondary }}>
            {owner.confirmation() === 'connection'
              ? tr(
                  'Delete this connection, its stored provider credential and model settings? Existing conversations keep their saved selection.',
                )
              : owner.confirmation() === 'key'
                ? tr('Remove the stored provider credential? This connection may stop working.')
                : tr('Remove this model from the connection?')}
          </Text>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}
          >
            <Button
              disabled={owner.busy()}
              onPress={inputAction(owner.cancelRemoval, owner.removalAction())}
              style={controlStyle}
              hoverStyle={controlHoverStyle()}
              activeStyle={{ backgroundColor: C.line }}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Cancel')}</Text>
            </Button>
            <Button
              disabled={disabled()}
              accessibilityLabel={tr('{action}: {name}', {
                action: removalLabel(),
                name: removalName(),
              })}
              onPress={inputAction(owner.remove, owner.removalAction())}
              style={{ ...controlStyle, backgroundColor: C.surface }}
              hoverStyle={controlHoverStyle()}
              activeStyle={{ backgroundColor: C.line }}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.danger, fontWeight: '500' }}>
                {removalLabel()}
              </Text>
            </Button>
          </View>
        </View>
      </If>
      <If when={!owner.confirmation() && !owner.discardTarget()}>
        <If when={owner.page() === 'connections'}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button
              disabled={disabled()}
              accessibilityLabel={tr('Add connection')}
              onPress={inputAction(owner.newConnection, null)}
              style={{
                ...controlStyle,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                backgroundColor: C.accent,
              }}
              hoverStyle={{ backgroundColor: C.accentHover }}
              activeStyle={{ backgroundColor: C.accentHover }}
              focusStyle={{
                ...controlFocusStyle(),
                backgroundColor: C.accentHover,
                outlineStyle: 'solid',
                outlineWidth: 2,
                outlineColor: C.accent,
                outlineOffset: 2,
              }}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="plus" color={C.background} />
              <Text style={{ ...captionTextStyle, color: C.background, fontWeight: '500' }}>
                {tr('Add connection')}
              </Text>
            </Button>
            <Button
              disabled={owner.loading() || owner.busy()}
              onPress={inputAction(owner.loadConnections, false)}
              style={{ ...controlStyle, minWidth: 144, alignItems: 'center' }}
              hoverStyle={controlHoverStyle()}
              activeStyle={{ backgroundColor: C.line }}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {owner.loading()
                  ? tr('Loading…')
                  : owner.error()
                    ? tr('Retry')
                    : tr('Refresh connections')}
              </Text>
            </Button>
          </View>
          <Search
            label={tr('Search connections')}
            placeholder={tr('Search connections…')}
            value={owner.connectionQuery}
            change={(text) => {
              owner.searchConnections(text);
              if (owner.filteredConnections().length)
                connectionsList?.scrollToIndex({ index: 0, animated: false });
            }}
          />
          <If
            when={
              !owner.loading() &&
              !owner.error() &&
              !owner.connections().length &&
              !owner.connectionQuery().trim()
            }
          >
            <Text style={{ ...bodyTextStyle, color: C.muted }}>
              {tr('Add your first connection, then fetch or add a model.')}
            </Text>
          </If>
          <List
            ref={(node) => {
              connectionsList = node;
            }}
            each={owner.filteredConnections()}
            keyExtractor={(item) => item.basis.connectionId}
            estimatedItemSize={64}
            onLoadMore={() => {
              if (!owner.error()) void owner.loadConnections(true);
            }}
            empty={
              <If when={!owner.loading() && !owner.error() && !!owner.connectionQuery().trim()}>
                <Text style={{ ...bodyTextStyle, color: C.muted }}>
                  {tr('No matching connections.')}
                </Text>
              </If>
            }
            style={{ flex: 1, minHeight: 0 }}
          >
            {(item) => (
              <Button
                disabled={unavailable() || !item().editable}
                accessibilityLabel={tr('Edit connection {name}', { name: item().name })}
                onPress={inputAction(owner.openConnection, item().basis)}
                style={{
                  height: 64,
                  padding: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  justifyContent: 'center',
                  borderRadius: 8,
                }}
                focusStyle={controlFocusStyle()}
                hoverStyle={controlHoverStyle()}
                activeStyle={{ backgroundColor: C.line }}
                disabledStyle={controlDisabledStyle}
              >
                <View style={[{ flex: 1, minWidth: 0, gap: 4 }, { pointerEvents: 'none' }]}>
                  <Text
                    style={[
                      { ...captionTextStyle, color: C.text, fontWeight: '500' },
                      { numberOfLines: 1, textOverflow: 'ellipsis' },
                    ]}
                  >
                    {item().name}
                  </Text>
                  <Text
                    style={[
                      { ...captionTextStyle, color: C.muted },
                      { numberOfLines: 1, textOverflow: 'ellipsis' },
                    ]}
                  >
                    {tr('{status} · {count} models', {
                      status: item().enabled ? tr('Enabled') : tr('Disabled'),
                      count: item().enabledModelCount,
                    })}
                  </Text>
                </View>
                <Icon name="right" color={C.muted} />
              </Button>
            )}
          </List>
        </If>
        <If when={owner.page() === 'providers'}>
          <ProviderPicker owner={owner} />
        </If>
        <If when={owner.page() === 'connection' && owner.editor()}>
          <ConnectionForm settings={owner} />
        </If>
        <If when={owner.page() === 'model' && owner.editor() && owner.model()}>
          <ConnectionModel settings={owner} />
        </If>
        <If when={owner.page() === 'models' && owner.editor()}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <If when={owner.editor()?.provider.descriptor.discovery}>
              <Button
                disabled={disabled() || owner.dirty()}
                onPress={inputAction(owner.discover, owner.action())}
                style={controlStyle}
                hoverStyle={controlHoverStyle()}
                activeStyle={{ backgroundColor: C.line }}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={{ ...captionTextStyle, color: C.text }}>
                  {owner.discovery() === 'fetching'
                    ? tr('Fetching models…')
                    : owner.discovery() === 'failed'
                      ? tr('Retry')
                      : tr('Fetch models')}
                </Text>
              </Button>
            </If>
            <Button
              disabled={disabled()}
              accessibilityLabel={tr('Add model manually')}
              onPress={inputAction(owner.editModel, { ...owner.action(), id: null })}
              style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
              hoverStyle={controlHoverStyle()}
              activeStyle={{ backgroundColor: C.line }}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="plus" color={C.secondary} />
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {tr('Add model manually')}
              </Text>
            </Button>
          </View>
          <Search
            label={tr('Search models')}
            placeholder={tr('Search models…')}
            value={owner.modelQuery}
            change={(text) => {
              owner.modelQuery.set(text);
              if (owner.filteredModels().length)
                modelsList?.scrollToIndex({ index: 0, animated: false });
            }}
          />
          <List
            ref={(node) => {
              modelsList = node;
            }}
            each={owner.filteredModels()}
            keyExtractor={(id) => id}
            estimatedItemSize={64}
            empty={
              <If
                when={
                  !owner.loading() &&
                  owner.discovery() !== 'fetching' &&
                  (!!owner.modelQuery().trim() || owner.discovery() !== 'failed')
                }
              >
                <Text style={{ ...bodyTextStyle, color: C.muted }}>
                  {owner.modelQuery().trim() ? tr('No matching models.') : tr('No models added.')}
                </Text>
              </If>
            }
            style={{ flex: 1, minHeight: 0 }}
          >
            {(id) => {
              const name = () =>
                owner.editor()?.baseline?.editing?.modelOverrides?.[id()]?.displayName ?? id();
              const isDefault = () =>
                owner.defaultTarget()?.connectionId ===
                  owner.editor()?.baseline?.target.connectionId &&
                owner.defaultTarget()?.modelId === id();
              return (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    height: 64,
                    paddingHorizontal: 8,
                    borderRadius: 8,
                    backgroundColor: isDefault() ? C.background : undefined,
                  }}
                >
                  <Button
                    disabled={disabled() || !owner.editor()?.enabled}
                    accessibilityLabel={tr('Set default {id}', { id: id() })}
                    tooltip={textTooltip(() => tr('Set default {id}', { id: id() }))}
                    selected={isDefault()}
                    onPress={inputAction(owner.setDefault, { ...owner.action(), id: id() })}
                    style={{
                      ...controlStyle,
                      width: 32,
                      height: 32,
                      paddingHorizontal: 0,
                      paddingVertical: 0,
                      alignItems: 'center',
                    }}
                    hoverStyle={controlHoverStyle()}
                    activeStyle={{ backgroundColor: C.line }}
                    focusStyle={controlFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <ChoiceIndicator
                      kind="radio"
                      checked={isDefault()}
                      disabled={disabled() || !owner.editor()?.enabled}
                    />
                  </Button>
                  <Button
                    disabled={disabled()}
                    style={{
                      ...controlStyle,
                      height: 48,
                      flex: 1,
                      minWidth: 0,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                    accessibilityLabel={tr('Edit model {id}', { id: id() })}
                    onPress={inputAction(owner.editModel, { ...owner.action(), id: id() })}
                    hoverStyle={controlHoverStyle()}
                    activeStyle={{ backgroundColor: C.line }}
                    focusStyle={controlFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <View style={[{ minWidth: 0, flex: 1 }, { pointerEvents: 'none' }]}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text
                          style={[
                            { ...captionTextStyle, color: C.text, minWidth: 0, flexShrink: 1 },
                            { numberOfLines: 1, textOverflow: 'ellipsis' },
                          ]}
                        >
                          {name()}
                        </Text>
                        <If when={isDefault()}>
                          <Text
                            style={{
                              ...captionTextStyle,
                              color: C.secondary,
                              flexShrink: 0,
                            }}
                          >
                            {tr('Default')}
                          </Text>
                        </If>
                      </View>
                      <If when={name() !== id()}>
                        <Text
                          style={[
                            { ...captionTextStyle, color: C.muted },
                            { numberOfLines: 1, textOverflow: 'ellipsis' },
                          ]}
                        >
                          {id()}
                        </Text>
                      </If>
                    </View>
                    <Icon name="right" color={C.muted} />
                  </Button>
                </View>
              );
            }}
          </List>
        </If>
      </If>
      <If when={owner.page() !== 'providers'}>
        <View style={{ minHeight: captionTextStyle.lineHeight }}>
          <If when={owner.loading()}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Loading settings…')}</Text>
          </If>
        </View>
      </If>
    </View>
  );
}

function Search(props: {
  label: string;
  placeholder: string;
  value(): string;
  change(text: string): void;
}) {
  return (
    <Input
      accessibilityLabel={props.label}
      value={props.value()}
      onChange={({ value }) => props.change(value)}
      placeholder={props.placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      submitBehavior="submit"
      style={{
        ...inputTextStyle,
        color: C.text,
        placeholderColor: C.muted,
        backgroundColor: C.background,
        height: 32,
        paddingHorizontal: 12,
        borderRadius: inputBorderRadius,
        borderWidth: 1,
        borderColor: C.line,
      }}
      focusStyle={{ borderColor: C.accent }}
    />
  );
}
