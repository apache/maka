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
import type { SkillSettingsOwner } from './skillSettingsState';
import { ConfigurationScope, LocationChoices, ManageButton } from './ConfigurationScope';
import { SettingsField } from './SettingsField';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import { tr } from './locale';
import { C, bodyTextStyle, captionTextStyle, inputTextStyle } from './ui';

export function SkillSettings(props: { owner: SkillSettingsOwner }) {
  const owner = props.owner;
  const disabled = () => owner.busy() || owner.loading();
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 12 }}>
      <ConfigurationScope owner={owner.scope} />
      <If when={owner.screen() === 'library'}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Input
            accessibilityLabel={tr('Search skills')}
            value={owner.query()}
            onChange={({ value }) => owner.query.set(value)}
            placeholder={tr('Search skills')}
            style={{
              ...inputTextStyle,
              flex: 1,
              minWidth: 0,
              padding: 8,
              color: C.text,
              backgroundColor: C.background,
            }}
          />
          <ManageButton
            label={tr('Refresh')}
            action={owner.refresh}
            argument={null}
            disabled={disabled()}
          />
          <If when={owner.page()?.writable}>
            <ManageButton
              label={tr('Add skills')}
              action={owner.add}
              argument={null}
              disabled={disabled()}
            />
          </If>
        </View>
        <Each of={owner.deleting() ? [owner.deleting()!] : []} key={(entry) => entry.reference}>
          {(item) => {
            const entry = item();
            return (
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
                  {tr('Delete skill directory?')}
                </Text>
                <Text style={{ userSelect: 'text', ...captionTextStyle, color: C.secondary }}>
                  {entry.path}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <ManageButton
                    label={tr('Delete')}
                    danger
                    action={owner.manage}
                    argument={{ entry, update: false }}
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
            );
          }}
        </Each>
        <List
          each={owner.entries()}
          keyExtractor={(entry) => entry.reference}
          estimatedItemSize={148}
          style={{ flex: 1, minHeight: 0 }}
        >
          {(entry) => (
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
                  <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>
                    {entry().name}
                  </Text>
                  <Text
                    style={{
                      ...captionTextStyle,
                      color:
                        entry().shadowedBy || !entry().preference.enabled ? C.muted : C.success,
                    }}
                  >
                    {!entry().valid
                      ? tr('Invalid skill')
                      : entry().shadowedBy
                        ? tr('Overridden')
                        : !entry().preference.enabled
                          ? tr('Disabled')
                          : tr('Effective')}
                  </Text>
                </View>
                <If when={owner.page()?.writable && entry().installation}>
                  <ManageButton
                    label={tr('Update skill {name} at {path}', {
                      name: entry().name,
                      path: entry().path,
                    })}
                    action={owner.manage}
                    argument={{ entry: entry(), update: true }}
                    disabled={disabled()}
                  >
                    <Icon name="refresh" color={C.secondary} />
                  </ManageButton>
                </If>
                <ManageButton
                  label={tr('Details')}
                  accessibilityLabel={tr('Details for skill {name} at {path}', {
                    name: entry().name,
                    path: entry().path,
                  })}
                  action={owner.open}
                  argument={entry()}
                  disabled={disabled()}
                />
                <If when={owner.page()?.writable && entry().location}>
                  <ManageButton
                    label={tr('Delete skill {name} at {path}', {
                      name: entry().name,
                      path: entry().path,
                    })}
                    action={(entry) => owner.deleting.set(entry)}
                    argument={entry()}
                    disabled={disabled()}
                  >
                    <Icon name="trash" color={C.secondary} />
                  </ManageButton>
                </If>
              </View>
              <Text style={{ ...bodyTextStyle, color: C.secondary }}>{entry().description}</Text>
              <Text style={{ userSelect: 'text', ...captionTextStyle, color: C.muted }}>
                {entry().bundled ? tr('Built-in') : entry().path}
              </Text>
            </View>
          )}
        </List>
        <If when={!owner.loading() && owner.page() && !owner.entries().length}>
          <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('No skills found.')}</Text>
        </If>
        <If when={owner.page()?.after}>
          <ManageButton
            label={tr('Load more')}
            action={owner.more}
            argument={null}
            disabled={disabled()}
          />
        </If>
      </If>
      <If when={owner.screen() === 'add'}>
        <List
          each={owner.discovered()?.skills ?? []}
          keyExtractor={(skill) => skill.directory}
          estimatedItemSize={100}
          style={{ flex: 1, minHeight: 0 }}
          contentStyle={{ gap: 12 }}
          header={() => (
            <View style={{ gap: 16 }}>
              <SettingsField
                label={tr('Skill source')}
                value={owner.sourceText()}
                change={(value) => owner.sourceText.set(value)}
                placeholder="owner/repository · https://… · /path/to/skills"
                disabled={disabled()}
              />
              <ManageButton
                label={tr('Discover skills')}
                action={owner.discover}
                argument={owner.sourceText()}
                disabled={disabled() || !owner.sourceText().trim()}
              />
              <If when={!!owner.discovered()?.skills.length}>
                <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('Install location')}</Text>
                <LocationChoices
                  targets={owner.page()?.targets ?? []}
                  selected={owner.location()}
                  choose={(location) => owner.location.set(location)}
                  disabled={disabled()}
                />
                <Text style={{ ...bodyTextStyle, color: C.text }}>
                  {tr('Select skills to install')}
                </Text>
              </If>
            </View>
          )}
          empty={() => (
            <If when={owner.discovered()}>
              <Text style={{ ...bodyTextStyle, color: C.muted }}>
                {tr('No valid SKILL.md found in this source.')}
              </Text>
            </If>
          )}
        >
          {(skill) => (
            <ManageButton
              label={skill().name}
              action={owner.choose}
              argument={skill().directory}
              disabled={disabled()}
            >
              <ChoiceIndicator
                kind="checkbox"
                checked={owner.selected().includes(skill().directory)}
              />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ ...bodyTextStyle, color: C.text }}>{skill().name}</Text>
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {skill().description}
                </Text>
                <Text style={{ ...captionTextStyle, color: C.muted }}>
                  {skill().directory || '.'}
                </Text>
              </View>
            </ManageButton>
          )}
        </List>
        <If when={!!owner.discovered()?.skills.length}>
          <ManageButton
            label={tr('Install selected skills')}
            action={owner.install}
            argument={owner.installInput()}
            disabled={disabled() || !owner.installInput()}
          />
        </If>
      </If>
      <Each
        of={owner.screen() === 'detail' && owner.document() ? [owner.document()!] : []}
        key={(document) => `${document.revision}:${document.offset}`}
      >
        {(item) => {
          const document = item();
          const entry = document.entry;
          return (
            <Scroll style={{ flex: 1, minHeight: 0 }}>
              <View style={{ gap: 12 }}>
                <Text style={{ ...bodyTextStyle, fontWeight: '600', color: C.text }}>
                  {entry.name}
                </Text>
                <Text style={{ ...bodyTextStyle, color: C.secondary }}>{entry.description}</Text>
                <Text style={{ userSelect: 'text', ...captionTextStyle, color: C.muted }}>
                  {entry.path}
                </Text>
                <If when={entry.installation}>
                  <Text style={{ userSelect: 'text', ...captionTextStyle, color: C.secondary }}>
                    {entry.installation!.source.kind === 'git'
                      ? entry.installation!.source.url
                      : entry.installation!.source.path}
                    {' / '}
                    {entry.installation!.directory || '.'}
                  </Text>
                </If>
                <If when={entry.shadowedBy}>
                  <Text style={{ userSelect: 'text', ...captionTextStyle, color: C.muted }}>
                    {tr('Overridden by {reference}', { reference: entry.shadowedBy! })}
                  </Text>
                </If>
                <Each of={entry.issues} key={(issue) => issue}>
                  {(issue) => (
                    <Text style={{ ...captionTextStyle, color: C.warning }}>{issue()}</Text>
                  )}
                </Each>
                <Text style={{ userSelect: 'text', ...bodyTextStyle, color: C.text }}>
                  {document.text}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <If when={document.before !== null && document.before !== undefined}>
                    <ManageButton
                      label={tr('Previous page')}
                      action={owner.readDocument}
                      argument={{
                        reference: entry.reference,
                        revision: document.revision,
                        offset: document.before!,
                      }}
                      disabled={disabled()}
                    />
                  </If>
                  <If when={document.after !== null && document.after !== undefined}>
                    <ManageButton
                      label={tr('Next page')}
                      action={owner.readDocument}
                      argument={{
                        reference: entry.reference,
                        revision: document.revision,
                        offset: document.after!,
                      }}
                      disabled={disabled()}
                    />
                  </If>
                </View>
              </View>
            </Scroll>
          );
        }}
      </Each>
      <If when={owner.loading()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Loading…')}</Text>
      </If>
    </View>
  );
}
