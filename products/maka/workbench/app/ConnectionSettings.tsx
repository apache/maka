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
import type { YNode } from 'nsh';
import { Button } from 'nsh/base';
import type { ModelSettingsOwner } from './settings';
import { ConnectionForm } from './ConnectionForm';
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
  let connectionsList: YNode | undefined;
  let providersList: YNode | undefined;
  let modelsList: YNode | undefined;
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <If when={owner.confirmation()}>
        <View
          style={{
            gap: 16,
            padding: 16,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: C.line,
            backgroundColor: C.background,
          }}
        >
          <Text style={{ ...bodyTextStyle, color: C.text }}>
            {owner.confirmation() === 'connection'
              ? tr(
                  'Delete this connection, its stored provider credential and model settings? Existing conversations keep their saved selection.',
                )
              : owner.confirmation() === 'key'
                ? tr('Remove the stored provider credential? This connection may stop working.')
                : tr('Remove this model from the connection?')}
          </Text>
          <Button
            disabled={disabled()}
            accessibilityLabel={tr('Confirm removal')}
            onPress={inputAction(owner.remove, owner.removalAction())}
            style={controlStyle}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.danger }}>{tr('Confirm removal')}</Text>
          </Button>
          <Button
            disabled={owner.busy()}
            onPress={inputAction(owner.cancelRemoval, owner.removalAction())}
            style={controlStyle}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Cancel')}</Text>
          </Button>
        </View>
      </If>
      <If when={!owner.confirmation()}>
        <If when={owner.page() === 'connections'}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button
              disabled={disabled()}
              accessibilityLabel={tr('Add connection')}
              onPress={inputAction(owner.newConnection, null)}
              style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="plus" color={C.accent} />
              <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Add connection')}</Text>
            </Button>
            <Button
              disabled={owner.loading() || owner.busy()}
              onPress={inputAction(owner.loadConnections, false)}
              style={controlStyle}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Refresh connections')}
              </Text>
            </Button>
          </View>
          <Search
            label={tr('Search connections')}
            placeholder={tr('Search connections…')}
            value={owner.connectionQuery}
            change={(text) => {
              owner.searchConnections(text);
              connectionsList?.scrollToIndex({ index: 0, animated: false });
            }}
          />
          <If
            when={
              !owner.loading() && !owner.connections().length && !owner.connectionQuery().trim()
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
              <If when={!owner.loading() && !!owner.connectionQuery().trim()}>
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
                  borderWidth: 1,
                  borderColor: C.line,
                  backgroundColor: C.background,
                }}
                focusStyle={{ backgroundColor: C.raised }}
                hoverStyle={{ backgroundColor: C.raised }}
                disabledStyle={controlDisabledStyle}
              >
                <View pointerEvents="none" style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <Text
                    numberOfLines={1}
                    style={{ ...captionTextStyle, color: C.text, fontWeight: '500' }}
                  >
                    {item().name}
                  </Text>
                  <Text numberOfLines={1} style={{ ...captionTextStyle, color: C.muted }}>
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
          <Text style={{ ...bodyTextStyle, color: C.muted }}>
            {tr('Choose the API provider for this connection.')}
          </Text>
          <Search
            label={tr('Search providers')}
            placeholder={tr('Search providers…')}
            value={owner.providerQuery}
            change={(text) => {
              owner.searchProviders(text);
              providersList?.scrollToIndex({ index: 0, animated: false });
            }}
          />
          <List
            ref={(node) => {
              providersList = node;
            }}
            each={owner.filteredProviders()}
            keyExtractor={(item) => JSON.stringify(item.identity)}
            estimatedItemSize={48}
            onLoadMore={() => {
              if (!owner.error()) void owner.loadProviders(true);
            }}
            empty={
              <If when={!owner.loading() && !!owner.providerQuery().trim()}>
                <Text style={{ ...bodyTextStyle, color: C.muted }}>
                  {tr('No matching providers.')}
                </Text>
              </If>
            }
            style={{ flex: 1, minHeight: 0 }}
          >
            {(item) => (
              <Button
                disabled={unavailable()}
                accessibilityLabel={tr('Connect {name}', { name: item().label })}
                onPress={inputAction(owner.chooseProvider, item().identity)}
                style={{
                  height: 48,
                  padding: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  justifyContent: 'center',
                  borderRadius: 8,
                  backgroundColor: C.background,
                }}
                focusStyle={{ backgroundColor: C.raised }}
                hoverStyle={{ backgroundColor: C.raised }}
                disabledStyle={controlDisabledStyle}
              >
                <Text numberOfLines={1} style={{ ...captionTextStyle, color: C.text, flex: 1 }}>
                  {item().label}
                </Text>
                <Icon name="right" color={C.muted} />
              </Button>
            )}
          </List>
        </If>
        <If when={owner.page() === 'connection' && owner.editor()}>
          <ConnectionForm settings={owner} />
        </If>
        <If when={owner.page() === 'model' && owner.editor() && owner.model()}>
          <ConnectionModel settings={owner} />
        </If>
        <If when={owner.page() === 'models' && owner.editor()}>
          <Button
            disabled={disabled()}
            accessibilityLabel={tr('Add model manually')}
            onPress={inputAction(owner.editModel, { ...owner.action(), id: null })}
            style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="plus" color={C.secondary} />
            <Text style={{ ...captionTextStyle, color: C.secondary }}>
              {tr('Add model manually')}
            </Text>
          </Button>
          <Search
            label={tr('Search models')}
            placeholder={tr('Search models…')}
            value={owner.modelQuery}
            change={(text) => {
              owner.modelQuery.set(text);
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
              <If when={!owner.loading() && !!owner.modelQuery().trim()}>
                <Text style={{ ...bodyTextStyle, color: C.muted }}>
                  {tr('No matching models.')}
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
                    padding: 8,
                  }}
                >
                  <Button
                    disabled={disabled()}
                    style={{ ...controlStyle, height: 48, flex: 1, minWidth: 0 }}
                    accessibilityLabel={tr('Edit model {id}', { id: id() })}
                    onPress={inputAction(owner.editModel, { ...owner.action(), id: id() })}
                    hoverStyle={controlHoverStyle}
                    focusStyle={controlFocusStyle}
                    disabledStyle={controlDisabledStyle}
                  >
                    <View pointerEvents="none" style={{ minWidth: 0 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text
                          numberOfLines={1}
                          ellipsizeMode="tail"
                          style={{ ...captionTextStyle, color: C.text, minWidth: 0, flexShrink: 1 }}
                        >
                          {name()}
                        </Text>
                        <If when={isDefault()}>
                          <Text
                            style={{
                              ...captionTextStyle,
                              color: C.secondary,
                              flexShrink: 0,
                              paddingHorizontal: 6,
                              backgroundColor: C.raised,
                              borderRadius: 4,
                            }}
                          >
                            {tr('Default')}
                          </Text>
                        </If>
                      </View>
                      <If when={name() !== id()}>
                        <Text
                          numberOfLines={1}
                          ellipsizeMode="tail"
                          style={{ ...captionTextStyle, color: C.muted }}
                        >
                          {id()}
                        </Text>
                      </If>
                    </View>
                  </Button>
                  <Button
                    disabled={disabled() || !owner.editor()?.enabled}
                    accessibilityLabel={tr('Set default {id}', { id: id() })}
                    tooltip={textTooltip(() => tr('Set default {id}', { id: id() }))}
                    selected={isDefault()}
                    onPress={inputAction(owner.setDefault, { ...owner.action(), id: id() })}
                    style={{
                      ...controlStyle,
                      width: 40,
                      height: 40,
                      paddingHorizontal: 0,
                      paddingVertical: 0,
                      alignItems: 'center',
                    }}
                    hoverStyle={controlHoverStyle}
                    focusStyle={controlFocusStyle}
                    disabledStyle={controlDisabledStyle}
                  >
                    <ChoiceIndicator
                      kind="radio"
                      checked={isDefault()}
                      disabled={disabled() || !owner.editor()?.enabled}
                    />
                  </Button>
                </View>
              );
            }}
          </List>
        </If>
      </If>
      <If when={owner.loading()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Loading settings…')}</Text>
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
      onChange={props.change}
      placeholder={props.placeholder}
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
  );
}
