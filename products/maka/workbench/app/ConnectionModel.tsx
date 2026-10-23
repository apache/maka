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
import { thinkingLevels, type ModelSettingsOwner } from './settings';
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
          disabled={disabled()}
          change={(label) => owner.changeModel({ label })}
          hint={tr('Optional. Empty uses the provider’s name.')}
        />
        <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
          {tr('Code Mode')}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <Each
            of={
              [
                { label: 'Default', value: null },
                { label: 'Enabled', value: true },
                { label: 'Disabled', value: false },
              ] as const
            }
            key={(item) => item.label}
          >
            {(item) => (
              <Button
                disabled={disabled()}
                selected={model().codeMode === item().value}
                onPress={inputAction(owner.changeCodeMode, {
                  ...owner.modelAction(),
                  enabled: item().value,
                })}
                style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
                disabledStyle={controlDisabledStyle}
              >
                <ChoiceIndicator
                  kind="radio"
                  checked={model().codeMode === item().value}
                  disabled={disabled()}
                />
                <Text style={{ ...captionTextStyle, color: C.text }}>{tr(item().label)}</Text>
              </Button>
            )}
          </Each>
        </View>
        <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
          {tr('Code Mode language')}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <Each of={['javascript', 'python'] as const} key={(language) => language}>
            {(language) => (
              <Button
                disabled={disabled()}
                selected={(model().codeModeLanguage ?? 'javascript') === language()}
                onPress={inputAction(owner.changeCodeLanguage, {
                  ...owner.modelAction(),
                  language: language(),
                })}
                style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
                disabledStyle={controlDisabledStyle}
              >
                <ChoiceIndicator
                  kind="radio"
                  checked={(model().codeModeLanguage ?? 'javascript') === language()}
                  disabled={disabled()}
                />
                <Text style={{ ...captionTextStyle, color: C.text }}>
                  {language() === 'python' ? 'Python' : 'JavaScript'}
                </Text>
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
        <If when={model().effective}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr('Current saved reasoning efforts: {levels}. Default: {level}.', {
              levels: model().effective!.thinkingLevels.join(', ') || tr('None'),
              level: model().effective!.defaultThinkingLevel ?? tr('Provider controlled'),
            })}
          </Text>
        </If>
        <Button
          disabled={disabled()}
          selected={model().thinkingLevels === null}
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
          <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Use provider defaults')}</Text>
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
          <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Provider default')}</Text>
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
