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

import {
  cleanup,
  computed,
  effect,
  inputAction,
  keymap,
  List,
  platform,
  Text,
  View,
  type InputRef,
  type ListRef,
} from 'nsh';
import { Button, Input } from 'nsh/base';
import type { SettingsProviderSummary } from '../../../../packages/plugin-sdk/src/index';
import type { ModelSettingsOwner } from './settings';
import { Icon } from './Icon';
import { tr, currentLocale } from './locale';
import { providerLabel } from './settingsLabels';
import {
  C,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  inputTextStyle,
  textTooltip,
} from './ui';
import { sameValue } from '../../../../plugins/shared/value';

type Row =
  | { kind: 'heading'; key: string; label: string }
  | { kind: 'provider'; key: string; provider: SettingsProviderSummary };
const identityKey = (provider: SettingsProviderSummary) =>
  JSON.stringify([
    provider.identity.packageId,
    provider.identity.entryId,
    provider.identity.scope,
    provider.identity.name,
  ]);

export function ProviderPicker(props: { owner: ModelSettingsOwner }) {
  const owner = props.owner;
  let list: ListRef | undefined;
  let input: InputRef | undefined;
  let removeKeys = () => {};
  cleanup(() => removeKeys());
  const disabled = () =>
    owner.busy() ||
    !owner.pendingKnown() ||
    owner.pending().length > 0 ||
    owner.openingProvider() !== null;
  const rows = computed<Row[]>(() => {
    const providers = [...owner.filteredProviders()].sort(
      (a, b) =>
        providerLabel(a.label).localeCompare(providerLabel(b.label), currentLocale()) ||
        identityKey(a).localeCompare(identityKey(b)),
    );
    const groups = [
      {
        key: 'account',
        label: tr('Account sign-in'),
        accepts: (p: SettingsProviderSummary) =>
          !p.customEndpoint && p.authentication.some((a) => a.interactive),
      },
      {
        key: 'custom',
        label: tr('Custom endpoints'),
        accepts: (p: SettingsProviderSummary) => p.customEndpoint,
      },
      {
        key: 'api',
        label: tr('API providers'),
        accepts: (p: SettingsProviderSummary) =>
          !p.customEndpoint && !p.authentication.some((a) => a.interactive),
      },
    ];
    return groups.flatMap((group): Row[] => {
      const items = providers.filter(group.accepts);
      return items.length
        ? [
            { kind: 'heading', key: group.key, label: group.label },
            ...items.map(
              (provider): Row => ({ kind: 'provider', key: identityKey(provider), provider }),
            ),
          ]
        : [];
    });
  });
  const choices = () =>
    rows().flatMap((row, index) =>
      row.kind === 'provider' ? [{ provider: row.provider, index }] : [],
    );
  effect(() => {
    const items = choices();
    if (!items.some(({ provider }) => sameValue(provider.identity, owner.selectedProvider()))) {
      owner.selectedProvider.set(items[0]?.provider.identity ?? null);
      if (items.length) list?.scrollToIndex({ index: 0, animated: false });
    }
  });
  const selectedIndex = () =>
    choices().findIndex(({ provider }) => sameValue(provider.identity, owner.selectedProvider()));
  const reveal = () => {
    const row = choices()[selectedIndex()];
    if (row) list?.scrollToIndex({ index: row.index, animated: false });
  };
  const move = (delta: number) => {
    if (disabled()) return;
    const items = choices();
    const row = items[Math.max(0, Math.min(items.length - 1, selectedIndex() + delta))];
    if (!row) return;
    owner.selectedProvider.set(row.provider.identity);
    reveal();
  };
  const choose = () => {
    if (disabled()) return;
    const row = choices()[selectedIndex()];
    if (row) void owner.chooseProvider(row.provider.identity);
  };
  const search = (text: string) => {
    owner.searchProviders(text);
    owner.selectedProvider.set(null);
    if (rows().length) list?.scrollToIndex({ index: 0, animated: false });
  };
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Input
          accessibilityLabel={tr('Search providers')}
          placeholder={tr('Search providers…')}
          readonly={!!owner.openingProvider()}
          autoCapitalize="none"
          autoCorrect={false}
          value={owner.providerQuery()}
          onChange={({ value }) => search(value)}
          onSubmit={choose}
          submitBehavior="submit"
          style={{
            ...inputTextStyle,
            flex: 1,
            minWidth: 0,
            height: 32,
            paddingHorizontal: 12,
            color: C.text,
            placeholderColor: C.muted,
            backgroundColor: C.background,
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: 8,
          }}
          focusStyle={{ borderColor: C.accent }}
          ref={(node) => {
            input = node;
            node.focus();
            removeKeys();
            const remove = [
              keymap.bind('up', () => move(-1), { within: node, when: 'always', repeat: true }),
              keymap.bind('down', () => move(1), { within: node, when: 'always', repeat: true }),
              keymap.bind(
                'escape',
                () => {
                  owner.cancel();
                  if (owner.page() === 'providers') input?.focus();
                },
                { within: node, when: 'always' },
              ),
            ];
            removeKeys = () => remove.forEach((unbind) => unbind());
          }}
        />
        <If when={owner.providerQuery()}>
          <Button
            accessibilityLabel={tr('Clear provider search')}
            tooltip={textTooltip(() => tr('Clear provider search'))}
            disabled={disabled()}
            onPress={() => {
              search('');
              input?.focus();
            }}
            style={{ ...controlStyle, width: 32, paddingHorizontal: 0 }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            activeStyle={{ backgroundColor: C.line }}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="close" color={C.secondary} />
          </Button>
        </If>
      </View>
      <List
        ref={(node) => {
          list = node;
          reveal();
        }}
        each={rows()}
        keyExtractor={(row) => row.key}
        estimatedItemSize={40}
        onLoadMore={() => {
          if (!owner.error() && !owner.openingProvider()) void owner.loadProviders(true);
        }}
        empty={
          <If when={!owner.loading() && !owner.error()}>
            <Text style={{ ...captionTextStyle, color: C.muted, paddingVertical: 16 }}>
              {owner.providerQuery().trim()
                ? tr('No matching providers.')
                : tr('No providers available.')}
            </Text>
          </If>
        }
        contentStyle={{ paddingRight: platform.isTerminal ? 0 : 8 }}
        style={{ flex: 1, minHeight: 0 }}
      >
        {(row) => {
          const heading = () => {
            const item = row();
            return item.kind === 'heading' ? [item] : [];
          };
          const option = () => {
            const item = row();
            return item.kind === 'provider' ? [item] : [];
          };
          return (
            <View style={{ height: row().kind === 'heading' ? 32 : 40 }}>
              <Each of={heading()} key={(item) => item.key}>
                {(item) => (
                  <Text
                    role="header"
                    style={{
                      ...captionTextStyle,
                      color: C.secondary,
                      fontWeight: '500',
                      height: 32,
                      paddingTop: 12,
                      paddingHorizontal: 8,
                    }}
                  >
                    {item().label}
                  </Text>
                )}
              </Each>
              <Each of={option()} key={(item) => item.key}>
                {(item) => (
                  <ProviderOption owner={owner} provider={item().provider} disabled={disabled()} />
                )}
              </Each>
            </View>
          );
        }}
      </List>
      <View style={{ minHeight: 32, flexDirection: 'row', alignItems: 'center' }}>
        <If
          when={owner.loading()}
          else={
            <If when={owner.error()}>
              <Button
                accessibilityLabel={
                  owner.failedProvider()
                    ? tr('Retry opening provider')
                    : tr('Retry loading providers')
                }
                disabled={owner.busy()}
                onPress={async () => {
                  const failed = owner.failedProvider();
                  if (failed) await owner.chooseProvider(failed);
                  else await owner.loadProviders(false);
                  if (owner.page() === 'providers') input?.focus();
                }}
                style={controlStyle}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                activeStyle={{ backgroundColor: C.line }}
              >
                <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Retry')}</Text>
              </Button>
            </If>
          }
        >
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {owner.openingProvider() ? '' : tr('Loading providers…')}
          </Text>
        </If>
      </View>
    </View>
  );
}

function ProviderOption(props: {
  owner: ModelSettingsOwner;
  provider: SettingsProviderSummary;
  disabled: boolean;
}) {
  const opening = () => sameValue(props.provider.identity, props.owner.openingProvider());
  return (
    <Button
      accessibilityLabel={tr('Connect {name}', { name: providerLabel(props.provider.label) })}
      tooltip={textTooltip(() => providerLabel(props.provider.label))}
      selected={sameValue(props.provider.identity, props.owner.selectedProvider())}
      disabled={props.disabled}
      onPress={inputAction(props.owner.chooseProvider, props.provider.identity)}
      style={{
        ...controlStyle,
        height: 40,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
      }}
      selectedStyle={{ backgroundColor: C.raised }}
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
      activeStyle={{ backgroundColor: C.line }}
      disabledStyle={opening() ? { opacity: 1 } : controlDisabledStyle}
    >
      <Text
        style={[
          { ...captionTextStyle, color: C.text, flex: 1, minWidth: 0 },
          { numberOfLines: 1, textOverflow: 'ellipsis' },
        ]}
      >
        {providerLabel(props.provider.label)}
      </Text>
      <If when={opening()} else={<Icon name="right" color={C.muted} />}>
        <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Opening…')}</Text>
      </If>
    </Button>
  );
}
