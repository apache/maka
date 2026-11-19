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

import { Scroll, signal, Text, View, windowSize } from 'nsh';
import { Button, Popover } from 'nsh/base';
import { Icon } from './Icon';
import { ChoiceIndicator } from './ChoiceIndicator';
import { C, captionTextStyle, controlStyle, controlDisabledStyle, floatingStyle } from './ui';
import type { PresetSettingsOwner } from './presetSettingsState';
import { LoadingIndicator } from './Loading';
import { tr } from './locale';
import {
  SettingsBody,
  SettingsButton,
  SettingsConfirm,
  SettingsDiscard,
  SettingsFormFooter,
  SettingsInput,
  SettingsRow,
  SettingsProblem,
  SettingsSection,
  SettingsSearch,
  SettingsSwitch,
  SettingsTextArea,
} from './SettingsPage';

export function SubagentSettings(props: { owner: PresetSettingsOwner }) {
  const owner = props.owner;
  const draft = () => owner.editor()!.values;
  const disabled = () => owner.busy() || owner.loading();
  const choice = owner.selectedModel;
  return (
    <If
      when={!owner.discarding.asking()}
      else={
        <SettingsDiscard
          name={owner.editor()?.values.name}
          onDiscard={owner.discarding.discard}
          onKeep={owner.discarding.keep}
        />
      }
    >
      <If
        when={!owner.deleting()}
        else={
          <SettingsConfirm
            title={tr('Delete subagent {name}?', { name: owner.deleting()!.name })}
            confirm={tr('Delete')}
            destructive
            disabled={disabled()}
            onConfirm={owner.remove}
            onCancel={() => owner.deleting.set(null)}
          />
        }
      >
        <If
          when={owner.editor()}
          else={
            <SettingsBody>
              <SettingsSection>
                <If when={owner.loading()}>
                  <LoadingIndicator />
                </If>
                <If when={!owner.loading() && owner.rows() === null}>
                  <SettingsProblem retry={owner.refresh} />
                </If>
                <SettingsButton
                  label={tr('Refresh')}
                  disabled={disabled()}
                  onPress={owner.refresh}
                />
                <If when={owner.rows()?.length === 0}>
                  <SettingsRow label={tr('No subagent presets.')} tone="muted" />
                </If>
                <Each of={owner.rows() ?? []} key={(row) => row.id}>
                  {(row) => (
                    <SettingsRow
                      label={row().name}
                      description={`${row().description} · ${row().model.connectionId} / ${row().model.modelId} · ${tr(row().availability.kind === 'available' ? 'Enabled' : row().availability.kind === 'disabled' ? 'Disabled' : row().availability.kind === 'modelUnavailable' ? 'The preset model is unavailable. Choose another model.' : 'The preset reasoning effort is unavailable.')}`}
                      opens
                      disabled={disabled()}
                      onPress={() => void owner.open(row().id)}
                    />
                  )}
                </Each>
              </SettingsSection>
            </SettingsBody>
          }
        >
          <SettingsBody
            footer={
              <SettingsFormFooter
                saveLabel={tr('Save subagent')}
                canSave={
                  !disabled() &&
                  !!draft().name.trim() &&
                  !!draft().description.trim() &&
                  !!draft().model.connectionId &&
                  !!draft().model.modelId
                }
                busy={owner.busy()}
                save={owner.save}
                cancel={owner.cancel}
              />
            }
          >
            <SettingsSection>
              <SettingsInput
                label={tr('Subagent name')}
                placeholder={tr('Subagent name placeholder')}
                value={draft().name}
                change={(value) => owner.change('name', value)}
                disabled={disabled()}
                autoFocus
                stacked
              />
              <SettingsRow label={tr('Description')} />
              <SettingsTextArea
                label={tr('Description')}
                placeholder={tr('Subagent description placeholder')}
                value={draft().description}
                change={(value) => owner.change('description', value)}
                disabled={disabled()}
                lines={3}
              />
              <SettingsRow label={tr('Role instruction')} />
              <SettingsTextArea
                label={tr('Role instruction')}
                placeholder={tr('Subagent instruction placeholder')}
                value={draft().instruction}
                change={(value) => owner.change('instruction', value)}
                disabled={disabled()}
                lines={12}
                monospace
              />
              <SettingsSwitch
                label={tr('Enabled')}
                checked={draft().enabled}
                onPress={() => owner.change('enabled', !draft().enabled)}
                disabled={disabled()}
              />
            </SettingsSection>
            <SettingsSection title={tr('Model')}>
              <PresetModelSelect owner={owner} disabled={disabled()} />
              <If when={draft().model.connectionId && !choice()}>
                <SettingsRow
                  label={tr('The preset model is unavailable. Choose another model.')}
                  tone="muted"
                />
              </If>
            </SettingsSection>
            <SettingsSection title={tr('Reasoning effort')}>
              <SettingsRow label={draft().thinkingLevel ?? tr('Default')} />
              <SettingsButton
                label={tr('Use provider settings')}
                onPress={() => owner.effort('')}
                disabled={disabled()}
              />
              <Each of={choice()?.thinkingLevels ?? []} key={(level) => level}>
                {(level) => (
                  <SettingsRow
                    label={level()}
                    disabled={disabled()}
                    onPress={() => owner.effort(level())}
                  />
                )}
              </Each>
            </SettingsSection>
            <If when={owner.editor()?.original}>
              <SettingsButton
                label={tr('Delete subagent')}
                tone="danger"
                disabled={disabled()}
                onPress={() => owner.deleting.set(owner.editor()!.original)}
              />
            </If>
          </SettingsBody>
        </If>
      </If>
    </If>
  );
}

function PresetModelSelect(props: { owner: PresetSettingsOwner; disabled: boolean }) {
  const owner = props.owner;
  const open = signal(false);
  const selected = owner.selectedModel;
  const caption = () => {
    const model = owner.editor()!.values.model;
    return selected()
      ? `${selected()!.label} · ${selected()!.sourceName}`
      : model.connectionId
        ? `${model.connectionId} / ${model.modelId}`
        : tr('Choose model');
  };
  return (
    <Popover
      open={open() && !props.disabled}
      onOpenChange={({ open: next }) => {
        if (!props.disabled) open.set(next);
      }}
      placement="bottom"
      align="start"
      offset={4}
      margin={8}
      popupStyle={{
        ...floatingStyle(),
        width: Math.min(400, Math.max(0, windowSize().width - 16)),
        maxHeight: Math.min(400, Math.max(0, windowSize().height - 16)),
      }}
      trigger={
        <Button
          accessibilityLabel={tr('Choose model')}
          disabled={props.disabled}
          style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
          hoverStyle={{ backgroundColor: C.line }}
          focusStyle={{ backgroundColor: C.line }}
          disabledStyle={controlDisabledStyle}
        >
          <Text
            style={[
              { ...captionTextStyle, color: C.text, flex: 1, minWidth: 0 },
              { numberOfLines: 1, textOverflow: 'ellipsis' },
            ]}
          >
            {caption()}
          </Text>
          <Icon name="down" color={C.muted} />
        </Button>
      }
    >
      <SettingsSearch
        label={tr('Search models and sources')}
        value={owner.query()}
        change={owner.searchModels}
      />
      <Scroll style={{ minHeight: 0, flexShrink: 1 }}>
        <View>
          <Each of={owner.models()} key={(row) => JSON.stringify(row.selection)}>
            {(row) => (
              <SettingsRow
                label={row().label}
                description={row().sourceName}
                selected={sameModel(row().selection)}
                trailing={<ChoiceIndicator kind="radio" checked={sameModel(row().selection)} />}
                onPress={() => {
                  owner.choose(row());
                  open.set(false);
                }}
              />
            )}
          </Each>
          <If when={!owner.modelLoading() && owner.models().length === 0}>
            <SettingsRow label={tr('No models match this search.')} tone="muted" />
          </If>
          <If when={owner.modelLoading()}>
            <LoadingIndicator />
          </If>
          <If when={owner.hasMoreModels()}>
            <SettingsButton
              label={tr('Load more models')}
              onPress={owner.moreModels}
              disabled={owner.modelLoading()}
            />
          </If>
        </View>
      </Scroll>
      <SettingsButton
        label={tr('Refresh models')}
        onPress={owner.refreshModels}
        disabled={owner.modelLoading()}
      />
    </Popover>
  );

  function sameModel(selection: NonNullable<ReturnType<typeof selected>>['selection']) {
    const model = owner.editor()!.values.model;
    return (
      selection.kind === 'model' &&
      selection.connectionId === model.connectionId &&
      selection.modelId === model.modelId
    );
  }
}
