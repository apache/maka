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
import { platform, Text, View } from 'nsh';
import type { SkillSettingsOwner } from './skillSettingsState';
import { ConfigurationScope, LocationChoices } from './ConfigurationScope';
import { ChoiceIndicator } from './ChoiceIndicator';
import { tr } from './locale';
import {
  SettingsBody,
  SettingsButton,
  SettingsConfirm,
  SettingsFormFooter,
  SettingsInput,
  SettingsLede,
  SettingsProblem,
  SettingsRow,
  SettingsSearch,
  SettingsSection,
  settingsInset,
} from './SettingsPage';
import { C } from './ui';

export function SkillSettings(props: { owner: SkillSettingsOwner }) {
  const owner = props.owner;
  return (
    <If when={!owner.deleting()} else={<Removal owner={owner} />}>
      <If when={owner.screen() === 'library'}>
        <Library owner={owner} />
      </If>
      <If when={owner.screen() === 'add'}>
        <AddSkills owner={owner} />
      </If>
      <If when={owner.screen() === 'detail'}>
        <Detail owner={owner} />
      </If>
    </If>
  );
}

function Library(props: { owner: SkillSettingsOwner }) {
  const owner = props.owner;
  const disabled = () => owner.busy() || owner.loading();
  return (
    <SettingsBody>
      <SettingsSection>
        <ConfigurationScope owner={owner.scope} />
      </SettingsSection>
      <If when={owner.entries().length > 8 || owner.query().trim()}>
        <SettingsSearch
          label={tr('Search skills')}
          value={owner.query()}
          change={(value) => owner.query.set(value)}
        />
      </If>
      <If when={owner.page()}>
        <SettingsSection title={tr('Skills')}>
          <Each of={owner.entries()} key={(entry) => entry.reference}>
            {(entry) => (
              <SettingsRow
                label={entry().name}
                description={entry().description}
                status={!entry().valid ? tr('Invalid skill') : undefined}
                tone={entry().shadowedBy || !entry().preference.enabled ? 'muted' : undefined}
                trailing={
                  <If when={entry().shadowedBy || !entry().preference.enabled}>
                    <Text style={{ fontSize: 13, lineHeight: 16, color: C.muted }}>
                      {entry().shadowedBy ? tr('Overridden') : tr('Disabled')}
                    </Text>
                  </If>
                }
                accessibilityLabel={tr('Details for skill {name} at {path}', {
                  name: entry().name,
                  path: entry().path,
                })}
                opens
                disabled={disabled()}
                onPress={() => void owner.open(entry())}
              />
            )}
          </Each>
          <If when={!owner.loading() && !owner.entries().length}>
            <SettingsRow label={tr('No skills found.')} tone="muted" />
          </If>
          <If when={owner.page()?.after}>
            <SettingsRow
              label={tr('Load more')}
              tone="muted"
              disabled={disabled()}
              onPress={owner.more}
            />
          </If>
        </SettingsSection>
      </If>
      <If when={owner.loading()}>
        <LoadingIndicator />
      </If>
      <If when={!owner.loading() && !owner.page()}>
        <SettingsProblem retry={owner.refresh} />
      </If>
    </SettingsBody>
  );
}

function Detail(props: { owner: SkillSettingsOwner }) {
  const owner = props.owner;
  const disabled = () => owner.busy() || owner.loading();
  return (
    <If
      when={owner.document()}
      else={
        <SettingsBody>
          <LoadingIndicator />
        </SettingsBody>
      }
    >
      <Each of={[owner.document()!]} key={(document) => `${document.revision}:${document.offset}`}>
        {(item) => {
          const document = item();
          const entry = document.entry;
          return (
            <SettingsBody>
              <SettingsLede>{entry.description}</SettingsLede>
              <SettingsSection>
                <SettingsRow
                  label={tr('Location')}
                  description={entry.bundled ? tr('Built-in') : entry.path}
                />
                <If when={entry.installation}>
                  <SettingsRow
                    label={tr('Source')}
                    description={`${
                      entry.installation!.source.kind === 'git'
                        ? entry.installation!.source.url
                        : entry.installation!.source.path
                    } / ${entry.installation!.directory || '.'}`}
                  />
                </If>
                <If when={entry.shadowedBy}>
                  <SettingsRow
                    label={tr('Overridden')}
                    description={tr('Overridden by {reference}', {
                      reference: entry.shadowedBy!,
                    })}
                  />
                </If>
                <Each of={entry.issues} key={(issue) => issue}>
                  {(issue) => <SettingsRow label={tr('Invalid skill')} status={issue()} />}
                </Each>
              </SettingsSection>
              <SettingsSection
                title="SKILL.md"
                trailing={
                  <>
                    <If when={document.before !== null && document.before !== undefined}>
                      <SettingsButton
                        label={tr('Previous page')}
                        tone="quiet"
                        disabled={disabled()}
                        onPress={() =>
                          void owner.readDocument({
                            reference: entry.reference,
                            revision: document.revision,
                            offset: document.before!,
                          })
                        }
                      />
                    </If>
                    <If when={document.after !== null && document.after !== undefined}>
                      <SettingsButton
                        label={tr('Next page')}
                        tone="quiet"
                        disabled={disabled()}
                        onPress={() =>
                          void owner.readDocument({
                            reference: entry.reference,
                            revision: document.revision,
                            offset: document.after!,
                          })
                        }
                      />
                    </If>
                  </>
                }
              >
                <View style={{ padding: settingsInset }}>
                  <Text
                    style={[
                      {
                        fontFamily: 'monospace',
                        fontSize: 13,
                        lineHeight: platform.isTerminal ? 16 : 20,
                        color: C.text,
                      },
                      { userSelect: 'text' },
                    ]}
                  >
                    {document.text}
                  </Text>
                </View>
              </SettingsSection>
              <If when={owner.page()?.writable && (entry.installation || entry.location)}>
                <SettingsSection>
                  <If when={entry.installation}>
                    <SettingsRow
                      label={tr('Update')}
                      accessibilityLabel={tr('Update skill {name} at {path}', {
                        name: entry.name,
                        path: entry.path,
                      })}
                      disabled={disabled()}
                      onPress={() => owner.manage({ entry, update: true })}
                    />
                  </If>
                  <If when={entry.location}>
                    <SettingsRow
                      label={tr('Delete')}
                      accessibilityLabel={tr('Delete skill {name} at {path}', {
                        name: entry.name,
                        path: entry.path,
                      })}
                      tone="danger"
                      disabled={disabled()}
                      onPress={() => owner.deleting.set(entry)}
                    />
                  </If>
                </SettingsSection>
              </If>
            </SettingsBody>
          );
        }}
      </Each>
    </If>
  );
}

function AddSkills(props: { owner: SkillSettingsOwner }) {
  const owner = props.owner;
  const disabled = () => owner.busy() || owner.loading();
  const skills = () => owner.discovered()?.skills ?? [];
  return (
    <SettingsBody
      footer={
        <SettingsFormFooter
          saveLabel={tr('Install selected skills')}
          canSave={!disabled() && !!owner.installInput()}
          busy={owner.busy()}
          save={() => owner.install(owner.installInput())}
          cancel={() => owner.back()}
        />
      }
    >
      <SettingsSection
        trailing={
          <SettingsButton
            label={tr('Discover skills')}
            disabled={disabled() || !owner.sourceText().trim()}
            onPress={() => void owner.discover(owner.sourceText())}
          />
        }
      >
        <SettingsInput
          label={tr('Skill source')}
          value={owner.sourceText()}
          change={(value) => owner.sourceText.set(value)}
          placeholder="owner/repository · https://… · /path/to/skills"
          disabled={disabled()}
          autoFocus
        />
      </SettingsSection>
      <If when={owner.loading()}>
        <LoadingIndicator />
      </If>
      <If when={owner.discovered() && !skills().length}>
        <SettingsLede>{tr('No valid SKILL.md found in this source.')}</SettingsLede>
      </If>
      <If when={skills().length > 0}>
        <SettingsSection>
          <LocationChoices
            targets={owner.page()?.targets ?? []}
            selected={owner.location()}
            choose={(location) => owner.location.set(location)}
            disabled={disabled()}
          />
        </SettingsSection>
        <SettingsSection title={tr('Select skills to install')}>
          <Each of={skills()} key={(skill) => skill.directory}>
            {(skill) => (
              <SettingsRow
                label={skill().name}
                description={`${skill().description} · ${skill().directory || '.'}`}
                leading={
                  <ChoiceIndicator
                    kind="checkbox"
                    checked={owner.selected().includes(skill().directory)}
                  />
                }
                selected={owner.selected().includes(skill().directory)}
                disabled={disabled()}
                onPress={() => owner.choose(skill().directory)}
              />
            )}
          </Each>
        </SettingsSection>
      </If>
    </SettingsBody>
  );
}

function Removal(props: { owner: SkillSettingsOwner }) {
  const owner = props.owner;
  const entry = () => owner.deleting()!;
  return (
    <SettingsConfirm
      title={tr('Delete skill directory?')}
      body={entry().path}
      confirm={tr('Delete')}
      destructive
      disabled={owner.busy() || owner.loading()}
      onConfirm={() => owner.manage({ entry: entry(), update: false })}
      onCancel={() => owner.back()}
    />
  );
}
