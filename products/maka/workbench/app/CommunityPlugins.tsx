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

import { cleanup, effect, openUrl, signal, View, Text, platform, reduceMotion } from 'nsh';
import { host } from 'maka/host';
import { Icon } from './Icon';
import { LoadingIndicator } from './Loading';
import {
  SettingsBody,
  SettingsButton,
  SettingsProblem,
  SettingsRow,
  SettingsSearch,
  SettingsSection,
  settingsInset,
} from './SettingsPage';
import { Button } from 'nsh/base';
import { C, captionTextStyle, controlFocusStyle, controlHoverStyle } from './ui';
import { currentLocale, tr } from './locale';

import type { PluginSettingsOwner } from './pluginSettingsState';
type Repo = {
  name: string;
  id?: string | null;
  description: string;
  installable: boolean;
  category: string;
  title: string;
};
function SearchPlaceholder() {
  const bar = { height: 9, borderRadius: 5, backgroundColor: C.line };
  return (
    <View role="progressbar" accessibilityLabel={tr('Reading plugins…')}>
      <If
        when={platform.idiom === 'terminal'}
        else={
          <View
            accessibilityElementsHidden
            style={{
              height: 54,
              paddingHorizontal: settingsInset,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 24,
              animationName: reduceMotion() ? 'none' : 'pulse',
              animationDuration: 1500,
              animationTimingFunction: 'ease-in-out',
              animationIterationCount: 'infinite',
              animationFrameRate: 30,
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: 7 }}>
              <View style={{ ...bar, width: '32%', maxWidth: 140 }} />
              <View style={{ ...bar, width: '72%', maxWidth: 320 }} />
            </View>
            <View style={{ width: 52, height: 24, borderRadius: 8, backgroundColor: C.raised }} />
          </View>
        }
      >
        <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Reading plugins…')}</Text>
      </If>
    </View>
  );
}
export function CommunityPlugins(props: { owner: PluginSettingsOwner }) {
  const query = props.owner.communityQuery,
    rows = signal<Repo[]>([]),
    busy = signal(false),
    more = signal(false),
    error = signal('');
  const category = signal('all');
  const filtered = () => rows().filter((r) => category() === 'all' || category() === r.category);
  let generation = 0,
    page = 0;
  async function load(term: string, next: number, ticket: number, locale = currentLocale()) {
    busy.set(true);
    error.set('');
    try {
      const found = await host.communityPlugins(term, next, locale);
      if (ticket !== generation) return;
      const combined = new Map((next === 1 ? [] : rows()).map((r) => [r.name, r]));
      for (const repo of found.repositories) combined.set(repo.name, repo);
      rows.set([...combined.values()]);
      page = next;
      more.set(found.more);
    } catch (e) {
      if (ticket === generation)
        error.set(
          String(e).includes('GitHub rate limit')
            ? tr('GitHub rate limit reached. Try again later.')
            : String(e),
        );
    } finally {
      if (ticket === generation) busy.set(false);
    }
  }
  effect(() => {
    const locale = currentLocale(),
      term = query().trim(),
      ticket = ++generation;
    rows.set([]);
    more.set(false);
    error.set('');
    busy.set(true);
    page = 0;
    const timer = setTimeout(() => void load(term, 1, ticket, locale), term ? 450 : 0);
    cleanup(() => {
      clearTimeout(timer);
      generation++;
    });
  });
  const reload = () => void load(query().trim(), 1, ++generation);
  return (
    <SettingsBody>
      <View style={{ gap: platform.idiom === 'terminal' ? 0 : 12 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingRight: settingsInset,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <SettingsSearch label={tr('Search plugins')} value={query()} change={query.set} />
          </View>
          <SettingsButton
            label={tr('Refresh')}
            icon="refresh"
            iconOnly
            tone="quiet"
            disabled={busy()}
            onPress={reload}
          />
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: settingsInset,
            columnGap: 20,
            flexWrap: 'wrap',
          }}
        >
          <Each of={['all', 'quick', 'other']} key={(value) => value}>
            {(value) => {
              const selected = () => category() === value();
              const label = () =>
                value() === 'all'
                  ? tr('All plugins')
                  : value() === 'quick'
                    ? tr('Quick tools')
                    : tr('Other plugins');
              return (
                <Button
                  accessibilityLabel={label()}
                  selected={selected()}
                  onPress={() => category.set(value())}
                  style={{
                    paddingHorizontal: 0,
                    paddingVertical: platform.idiom === 'terminal' ? 0 : 6,
                    borderBottomWidth: platform.idiom === 'terminal' ? 0 : 2,
                    borderBottomColor: selected() ? C.text : 'transparent',
                  }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                >
                  <Text
                    style={{
                      ...captionTextStyle,
                      color: selected() ? C.text : C.secondary,
                      fontWeight: '500',
                    }}
                  >
                    {label()}
                  </Text>
                </Button>
              );
            }}
          </Each>
        </View>
        <SettingsSection>
          <Each of={filtered()} key={(r: Repo) => r.name}>
            {(r) => (
              <SettingsRow
                label={r().title || r().name}
                description={r().description}
                trailing={
                  r().installable ? (
                    <If
                      when={props.owner.installingCommunity() === r().name}
                      else={
                        <If
                          when={!!props.owner.communityInstance(r().name, r().id)}
                          else={
                            <SettingsButton
                              label={tr('Install')}
                              disabled={props.owner.disabled()}
                              onPress={() => void props.owner.installCommunity(r().name)}
                            />
                          }
                        >
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Icon name="check" color={C.secondary} size={14} />
                            <Text style={{ ...captionTextStyle, color: C.secondary }}>
                              {tr('Installed')}
                            </Text>
                          </View>
                        </If>
                      }
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <LoadingIndicator size={14} label={tr('Installing…')} />
                        <Text style={{ ...captionTextStyle, color: C.secondary }}>
                          {tr('Installing…')}
                        </Text>
                      </View>
                    </If>
                  ) : undefined
                }
                opens={!r().installable}
                onPress={
                  r().installable
                    ? undefined
                    : () =>
                        void openUrl('https://github.com/' + r().name).catch((e) =>
                          error.set(String(e)),
                        )
                }
              />
            )}
          </Each>
          <If when={busy()}>
            <SearchPlaceholder />
          </If>
          <If when={error() !== ''}>
            <SettingsProblem message={error()} retry={reload} />
          </If>
          <If when={!busy() && !error() && !filtered().length && !more()}>
            <SettingsRow label={tr('No matching plugins.')} tone="muted" />
          </If>
          <If when={more() && !busy()}>
            <SettingsButton
              label={tr('Load more')}
              onPress={() => void load(query().trim(), page + 1, ++generation)}
            />
          </If>
        </SettingsSection>
      </View>
    </SettingsBody>
  );
}
