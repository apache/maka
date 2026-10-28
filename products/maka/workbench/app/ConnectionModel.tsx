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
import { modelLimitFields, thinkingLevels, type ModelSettingsOwner } from './settings';
import { SettingsField } from './SettingsField';
import { ChoiceIndicator } from './ChoiceIndicator';
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

export function ConnectionModel(props: { settings: ModelSettingsOwner }) {
  const owner = props.settings;
  const model = () => owner.model()!;
  const disabled = () =>
    owner.busy() || owner.loading() || !owner.pendingKnown() || owner.pending().length > 0;
  const supported = () => model().thinkingLevels ?? model().effective?.thinkingLevels ?? [];
  const inherited = (value: string | number | boolean | null | undefined, empty?: string) => {
    if (!model().id.trim()) return tr('Enter a model ID to see defaults.');
    if (owner.modelLoading()) return tr('Loading…');
    if (!model().defaults) return tr('Defaults unavailable');
    if (value == null) return empty ?? tr('Provider controlled');
    return typeof value === 'boolean' ? tr(value ? 'Enabled' : 'Disabled') : String(value);
  };
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ padding: 8, gap: 16 }}>
        <SettingsField
          label={tr('Model ID')}
          value={model().id}
          readonly={model().originalId !== null}
          disabled={disabled()}
          change={(id) => owner.changeModel({ id })}
          hint={tr('The exact API model ID, including its provider prefix when required.')}
        />
        <SettingsField
          label={tr('Model display name')}
          value={model().label}
          placeholder={inherited(model().defaults?.label)}
          disabled={disabled()}
          change={(label) => owner.changeModel({ label })}
          hint={tr('Optional. Empty uses the provider’s name.')}
        />
        <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
          {tr('Context & output')}
        </Text>
        <Each of={modelLimitFields} key={(field) => field.key}>
          {(field) => (
            <SettingsField
              label={tr(field().label)}
              value={model().limits[field().key]}
              placeholder={inherited(
                model().defaults?.[field().key],
                field().key === 'compactionThreshold' ? tr('No automatic threshold') : undefined,
              )}
              disabled={disabled()}
              change={(value) =>
                owner.changeModel({ limits: { ...model().limits, [field().key]: value } })
              }
              hint={tr(field().hint)}
            />
          )}
        </Each>
        <If when={model().effective?.limits}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr('Effective context: {context} · input: {input} · provider output limit: {output}', {
              context: model().effective!.limits!.contextWindow ?? tr('Provider controlled'),
              input: model().effective!.limits!.inputLimit ?? tr('Provider controlled'),
              output: model().effective!.limits!.maxOutputTokens ?? tr('Provider controlled'),
            })}
          </Text>
        </If>
        <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>{tr('Tools')}</Text>
        <Each
          of={
            [
              {
                key: 'codeMode',
                label: 'Code Mode',
                hint: 'Run tool calls through Code Mode. Model default follows the built-in policy for this model.',
              },
              {
                key: 'applyPatch',
                label: 'Apply Patch',
                hint: 'Use apply_patch for file edits. Disabled uses structured edit and write tools. Independent of Code Mode.',
              },
            ] as const
          }
          key={(tool) => tool.key}
        >
          {(tool) => (
            <View style={{ gap: 8 }}>
              <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
                {tr(tool().label)}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                <Each
                  of={
                    [
                      { label: 'Model default', value: null },
                      { label: 'Enabled', value: true },
                      { label: 'Disabled', value: false },
                    ] as const
                  }
                  key={(item) => item.label}
                >
                  {(item) => (
                    <Button
                      disabled={disabled()}
                      selected={model()[tool().key] === item().value}
                      accessibilityLabel={tr('{tool}: {value}', {
                        tool: tr(tool().label),
                        value: tr(item().label),
                      })}
                      onPress={inputAction(owner.changeTool, {
                        ...owner.modelAction(),
                        tool: tool().key,
                        enabled: item().value,
                      })}
                      style={{
                        ...controlStyle,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                      }}
                      hoverStyle={controlHoverStyle}
                      focusStyle={controlFocusStyle}
                      disabledStyle={controlDisabledStyle}
                    >
                      <ChoiceIndicator
                        kind="radio"
                        checked={model()[tool().key] === item().value}
                        disabled={disabled()}
                      />
                      <Text style={{ ...captionTextStyle, color: C.text }}>
                        {item().value === null
                          ? tr('Model default ({value})', {
                              value: inherited(model().defaults?.[tool().key]),
                            })
                          : tr(item().label)}
                      </Text>
                    </Button>
                  )}
                </Each>
              </View>
              <Text style={{ ...captionTextStyle, color: C.muted }}>{tr(tool().hint)}</Text>
            </View>
          )}
        </Each>
        <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
          {tr('Code Mode language')}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <Each
            of={
              [
                { value: 'javascript', label: 'JavaScript' },
                { value: 'python', label: 'Python' },
              ] as const
            }
            key={(language) => language.label}
          >
            {(language) => (
              <Button
                disabled={disabled()}
                selected={(model().codeModeLanguage ?? 'javascript') === language().value}
                accessibilityLabel={tr('Code Mode language: {language}', {
                  language: language().label,
                })}
                onPress={inputAction(owner.changeCodeLanguage, {
                  ...owner.modelAction(),
                  language: language().value,
                })}
                style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
                disabledStyle={controlDisabledStyle}
              >
                <ChoiceIndicator
                  kind="radio"
                  checked={(model().codeModeLanguage ?? 'javascript') === language().value}
                  disabled={disabled()}
                />
                <Text style={{ ...captionTextStyle, color: C.text }}>{language().label}</Text>
              </Button>
            )}
          </Each>
        </View>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {tr('Used when Code Mode is enabled. Applies to newly submitted messages.')}
        </Text>
        <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
          {tr('Supported reasoning efforts')}
        </Text>
        <Button
          disabled={disabled()}
          selected={model().thinkingLevels === null}
          accessibilityLabel={tr('Use provider defaults ({value})', {
            value: inherited(model().defaults?.thinkingLevels.join(', ') || tr('None')),
          })}
          onPress={inputAction(owner.useProviderThinking, owner.modelAction())}
          style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 12 }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
          disabledStyle={controlDisabledStyle}
        >
          <ChoiceIndicator
            kind="radio"
            checked={model().thinkingLevels === null}
            disabled={disabled()}
          />
          <Text style={{ ...captionTextStyle, color: C.text }}>
            {tr('Use provider defaults ({value})', {
              value: inherited(model().defaults?.thinkingLevels.join(', ') || tr('None')),
            })}
          </Text>
        </Button>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
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
                style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
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
        <Text style={{ ...bodyTextStyle, color: C.muted }}>
          {tr(
            'Select the reasoning efforts supported by this model. They will be available in conversations.',
          )}
        </Text>
        <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
          {tr('Connection default reasoning effort')}
        </Text>
        <Button
          disabled={disabled()}
          selected={model().defaultThinkingLevel === null}
          accessibilityLabel={tr('Provider default ({value})', {
            value: inherited(model().defaults?.defaultThinkingLevel),
          })}
          onPress={inputAction(owner.defaultThinking, { ...owner.modelAction(), level: null })}
          style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 12 }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
          disabledStyle={controlDisabledStyle}
        >
          <ChoiceIndicator
            kind="radio"
            checked={model().defaultThinkingLevel === null}
            disabled={disabled()}
          />
          <Text style={{ ...captionTextStyle, color: C.text }}>
            {tr('Provider default ({value})', {
              value: inherited(model().defaults?.defaultThinkingLevel),
            })}
          </Text>
        </Button>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <Each of={supported()} key={(level) => level}>
            {(level) => (
              <Button
                disabled={disabled()}
                selected={model().defaultThinkingLevel === level()}
                accessibilityLabel={tr('Default effort {level}', { level: level() })}
                onPress={inputAction(owner.defaultThinking, {
                  ...owner.modelAction(),
                  level: level(),
                })}
                style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
                disabledStyle={controlDisabledStyle}
              >
                <ChoiceIndicator
                  kind="radio"
                  checked={model().defaultThinkingLevel === level()}
                  disabled={disabled()}
                />
                <Text style={{ ...captionTextStyle, color: C.text }}>{level()}</Text>
              </Button>
            )}
          </Each>
        </View>
        <Button
          disabled={disabled()}
          accessibilityLabel={tr('Save model')}
          onPress={inputAction(owner.saveModel, owner.modelAction())}
          style={{ ...controlStyle, alignSelf: 'flex-start', backgroundColor: C.accent }}
          hoverStyle={{ backgroundColor: C.accentHover }}
          focusStyle={{ backgroundColor: C.accentHover }}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.background, fontWeight: '500' }}>
            {owner.busy() ? tr('Saving…') : tr('Save model')}
          </Text>
        </Button>
        <If when={model().originalId !== null}>
          <Button
            disabled={disabled()}
            onPress={inputAction(owner.confirm, {
              ...owner.action(),
              kind: 'model',
              modelId: model().originalId,
            })}
            style={controlStyle}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.danger }}>{tr('Remove model')}</Text>
          </Button>
        </If>
      </View>
    </Scroll>
  );
}
