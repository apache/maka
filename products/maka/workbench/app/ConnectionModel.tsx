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

import { inputAction, platform, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type {
  CodeLanguage,
  ThinkingLevel,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import { modelLimitFields, thinkingLevels, type ModelSettingsOwner } from './settings';
import { CatalogModelAssociation } from './CatalogModelAssociation';
import { ChoiceIndicator } from './ChoiceIndicator';
import { tr } from './locale';
import { renderText } from './text';
import {
  SettingsBody,
  SettingsButton,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from './SettingsPage';
import {
  C,
  captionTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
} from './ui';

const tools = [
  { key: 'codeMode', label: 'Code Mode' },
  { key: 'applyPatch', label: 'Apply Patch' },
] as const;
const hint = (field: (typeof modelLimitFields)[number]) =>
  'hint' in field ? tr(field.hint) : undefined;
const toolValue = (value: boolean | null) => (value === null ? '' : value ? 'on' : 'off');

export function ConnectionModel(props: { settings: ModelSettingsOwner }) {
  const owner = props.settings;
  const model = () => owner.model()!;
  const connectionId = () => owner.editor()!.baseline!.target.connectionId;
  const disabled = () =>
    owner.busy() || owner.loading() || !owner.pendingKnown() || owner.pending().length > 0;
  const supported = () => model().thinkingLevels ?? model().effective?.thinkingLevels ?? [];
  /** The value used when this model sets none; unknown until its ID resolves. */
  const inherited = (value: string | number | boolean | null | undefined, empty?: string) => {
    if (!model().id.trim() || owner.modelLoading() || !model().defaults) return undefined;
    if (value == null) return empty ?? tr('Provider controlled');
    return typeof value === 'boolean' ? tr(value ? 'Enabled' : 'Disabled') : String(value);
  };
  const fallback = (title: 'Provider default' | 'Model default', value: string | undefined) =>
    value === undefined
      ? tr(title)
      : title === 'Provider default'
        ? tr('Provider default ({value})', { value })
        : tr('Model default ({value})', { value });
  const isDefault = () =>
    owner.defaultTarget()?.connectionId === connectionId() &&
    owner.defaultTarget()?.modelId === model().originalId;
  const saveable = () => owner.modelDirty() || model().originalId === null;
  return (
    <SettingsBody
      footer={
        saveable() ? (
          <SettingsButton
            label={owner.busy() ? tr('Saving…') : tr('Save')}
            accessibilityLabel={tr('Save model')}
            tone="primary"
            disabled={
              disabled() || !owner.modelDirty() || !!owner.modelProblem() || !model().id.trim()
            }
            onPress={inputAction(owner.saveModel, owner.modelAction())}
          />
        ) : undefined
      }
    >
      <SettingsSection>
        <SettingsInput
          label={tr('Model ID')}
          autoFocus={model().originalId === null}
          value={model().id}
          readonly={model().originalId !== null}
          disabled={disabled()}
          change={(id) => owner.changeModel({ id })}
        />
        <SettingsInput
          label={tr('Model display name')}
          value={model().label}
          placeholder={inherited(model().defaults?.label)}
          disabled={disabled()}
          change={(label) => owner.changeModel({ label })}
        />
        <CatalogModelAssociation settings={owner} disabled={disabled()} />
        <If when={model().originalId !== null}>
          <SettingsSwitch
            label={tr('Default for new conversations')}
            checked={isDefault()}
            disabled={disabled() || !owner.editor()!.enabled}
            onPress={() =>
              void owner.setDefault(
                isDefault() ? null : { connectionId: connectionId(), modelId: model().originalId! },
              )
            }
          />
        </If>
      </SettingsSection>
      <SettingsSection title={tr('Context & output')}>
        <Each of={modelLimitFields} key={(field) => field.key}>
          {(field) => (
            <SettingsInput
              label={tr(field().label)}
              description={hint(field())}
              value={model().limits[field().key]}
              placeholder={inherited(
                model().defaults?.[field().key],
                field().key === 'compactionThreshold' ? tr('No automatic threshold') : undefined,
              )}
              disabled={disabled()}
              change={(value) =>
                owner.changeModel({ limits: { ...model().limits, [field().key]: value } })
              }
              error={
                owner.modelProblem()?.field === field().label
                  ? renderText(owner.modelProblem()!.text)
                  : undefined
              }
            />
          )}
        </Each>
      </SettingsSection>
      <SettingsSection title={tr('Reasoning effort')}>
        <SettingsSelect
          label={tr('Connection default reasoning effort')}
          value={model().defaultThinkingLevel ?? ''}
          disabled={disabled()}
          choices={[
            {
              value: '',
              title: fallback(
                'Provider default',
                inherited(model().defaults?.defaultThinkingLevel),
              ),
            },
            ...supported().map((level) => ({ value: level, title: level })),
          ]}
          change={(value) =>
            owner.defaultThinking({
              ...owner.modelAction(),
              level: value ? (value as ThinkingLevel) : null,
            })
          }
        />
        <SettingsSwitch
          label={tr('Use provider reasoning efforts')}
          description={inherited(model().defaults?.thinkingLevels.join(', ') || tr('None'))}
          checked={model().thinkingLevels === null}
          disabled={disabled()}
          onPress={() =>
            model().thinkingLevels === null
              ? owner.changeModel({ thinkingLevels: [...supported()] })
              : owner.useProviderThinking(owner.modelAction())
          }
        />
        <If when={model().thinkingLevels !== null}>
          <SettingsRow
            label={tr('Supported reasoning efforts')}
            trailing={
              <View
                style={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  justifyContent: 'flex-end',
                  gap: 4,
                  flexShrink: 1,
                }}
              >
                <Each of={thinkingLevels} key={(level) => level}>
                  {(level) => (
                    <Button
                      disabled={disabled()}
                      selected={supported().includes(level())}
                      accessibilityLabel={tr('Support effort {level}', { level: level() })}
                      onPress={inputAction(owner.toggleThinking, {
                        ...owner.modelAction(),
                        level: level(),
                      })}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        minHeight: platform.isTerminal ? 16 : 28,
                        paddingHorizontal: platform.isTerminal ? 0 : 8,
                        borderRadius: 8,
                      }}
                      hoverStyle={controlHoverStyle()}
                      focusStyle={controlFocusStyle()}
                      activeStyle={{ backgroundColor: C.line }}
                      disabledStyle={controlDisabledStyle}
                    >
                      <ChoiceIndicator
                        kind="checkbox"
                        checked={supported().includes(level())}
                        disabled={disabled()}
                      />
                      <Text style={{ ...captionTextStyle, color: C.text }}>{level()}</Text>
                    </Button>
                  )}
                </Each>
              </View>
            }
          />
        </If>
      </SettingsSection>
      <SettingsSection title={tr('Model capabilities')}>
        <Each of={tools} key={(tool) => tool.key}>
          {(tool) => (
            <SettingsSelect
              label={tr(tool().label)}
              value={toolValue(model()[tool().key])}
              disabled={disabled()}
              choices={[
                {
                  value: '',
                  title: fallback('Model default', inherited(model().defaults?.[tool().key])),
                },
                { value: 'on', title: tr('Enabled') },
                { value: 'off', title: tr('Disabled') },
              ]}
              change={(value) =>
                owner.changeTool({
                  ...owner.modelAction(),
                  tool: tool().key,
                  enabled: value === '' ? null : value === 'on',
                })
              }
            />
          )}
        </Each>
        <SettingsSelect
          label={tr('Code Mode language')}
          value={model().codeModeLanguage ?? 'javascript'}
          disabled={disabled()}
          choices={[
            { value: 'javascript', title: 'JavaScript' },
            { value: 'python', title: 'Python' },
          ]}
          change={(value) =>
            owner.changeCodeLanguage({ ...owner.modelAction(), language: value as CodeLanguage })
          }
        />
      </SettingsSection>
      <If when={model().originalId !== null}>
        <SettingsSection>
          <SettingsRow
            label={tr('Remove model')}
            tone="danger"
            disabled={disabled()}
            onPress={inputAction(owner.confirm, {
              ...owner.action(),
              kind: 'model',
              modelId: model().originalId,
            })}
          />
        </SettingsSection>
      </If>
    </SettingsBody>
  );
}
