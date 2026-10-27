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

import { inputAction, platform, Scroll, Text, View } from 'nsh';
import { tr } from './locale';
import { Button } from 'nsh/base';
import {
  assistantLanguages,
  type GeneralAction,
  type GeneralSettingsOwner,
} from './generalSettings.ts';
import { SettingsEditor, SettingsField } from './SettingsField';
import { UiScaleSettings } from './UiScaleSettings';
import { uiScale } from './uiScale';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import {
  bodyTextStyle,
  captionTextStyle,
  C,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

export function GeneralSettings(props: { owner: GeneralSettingsOwner }) {
  const owner = props.owner;
  return (
    <Scroll style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          padding: 8,
          gap: 16,
          height:
            owner.editor()?.kind === 'globalInstructions' || owner.editor()?.kind === 'compaction'
              ? '100%'
              : undefined,
        }}
      >
        <If when={owner.loading()}>
          <Text style={{ ...bodyTextStyle, color: C.muted }}>
            {owner.editor()?.kind === 'globalInstructions'
              ? tr('Reading global instructions…')
              : tr('Reading preferences…')}
          </Text>
        </If>
        <Each of={[owner.action()]} key={(request) => JSON.stringify(request)}>
          {(action) => {
            const request = action();
            if (request.kind === 'root') return <GeneralRoot owner={owner} request={request} />;
            if (request.kind === 'globalInstructions')
              return <GlobalInstructionsEditor owner={owner} request={request} />;
            return <PreferenceEditor owner={owner} request={request} />;
          }}
        </Each>
      </View>
    </Scroll>
  );
}

function GeneralRoot(props: { owner: GeneralSettingsOwner; request: GeneralAction }) {
  const owner = props.owner;
  const request = props.request;
  return (
    <View style={{ gap: 16 }}>
      <Button
        disabled={owner.loading() || owner.busy()}
        onPress={inputAction(owner.reload, request)}
        accessibilityLabel={tr('Refresh general preferences')}
        focusStyle={controlFocusStyle}
        style={{ ...controlStyle, alignSelf: 'flex-start' }}
        hoverStyle={controlHoverStyle}
        disabledStyle={controlDisabledStyle}
      >
        <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Refresh preferences')}</Text>
      </Button>
      {/* A terminal without pixel scaling is sized by its font; a desktop window has neither. */}
      <If when={uiScale.supported || platform.isTerminal}>
        <UiScaleSettings />
      </If>
      <If when={owner.facts()}>
        <View style={{ gap: 8 }}>
          <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>
            {tr('Language')}
          </Text>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr('Language used by the interface and assistant.')}
          </Text>
          <If when={owner.facts()?.language == null}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {tr('Using the default language.')}
            </Text>
          </If>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Each of={assistantLanguages()} key={(language) => language.value}>
              {(language) => (
                <Button
                  selected={(owner.facts()?.language ?? 'auto') === language().value}
                  disabled={owner.disabled()}
                  accessibilityLabel={tr('Language: {language}', { language: language().label })}
                  onPress={inputAction(owner.language, { request, preference: language().value })}
                  style={{
                    ...controlStyle,
                    minHeight: 40,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  selectedStyle={{ backgroundColor: C.raised }}
                  hoverStyle={controlHoverStyle}
                  focusStyle={controlFocusStyle}
                  disabledStyle={controlDisabledStyle}
                >
                  <ChoiceIndicator
                    kind="radio"
                    checked={(owner.facts()?.language ?? 'auto') === language().value}
                    disabled={owner.disabled()}
                  />
                  <Text
                    style={{
                      ...bodyTextStyle,
                      color:
                        (owner.facts()?.language ?? 'auto') === language().value
                          ? C.accent
                          : C.text,
                    }}
                  >
                    {language().label}
                  </Text>
                </Button>
              )}
            </Each>
          </View>
        </View>
        <View style={{ gap: 8 }}>
          <PreferenceToggle
            owner={owner}
            request={request}
            kind="instructions"
            label={tr('Workspace instructions')}
            enabled={owner.facts()?.workspaceInstructions ?? false}
          />
          <PreferenceToggle
            owner={owner}
            request={request}
            kind="privacy"
            label={tr('Incognito mode')}
            enabled={owner.facts()?.incognitoActive ?? false}
          />
          <PreferenceToggle
            owner={owner}
            request={request}
            kind="titles"
            label={tr('Automatic shell titles')}
            enabled={owner.facts()?.shellTitles ?? false}
          />
        </View>
        <Button
          disabled={owner.disabled()}
          onPress={inputAction(owner.open, { request, kind: 'personalization' })}
          accessibilityLabel={tr('Edit personalization')}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
          style={{
            ...controlStyle,
            minHeight: 56,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}
          disabledStyle={controlDisabledStyle}
        >
          <View pointerEvents="none" style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('Personalization')}</Text>
            <Text numberOfLines={1} style={{ ...captionTextStyle, color: C.muted }}>
              {owner.facts()?.displayName || tr('Display name')}
            </Text>
          </View>
          <Icon name="right" color={C.muted} />
        </Button>
        <Button
          disabled={owner.disabled()}
          onPress={inputAction(owner.open, { request, kind: 'compaction' })}
          accessibilityLabel={tr('Edit compaction prompt')}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
          style={{
            ...controlStyle,
            minHeight: 56,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}
          disabledStyle={controlDisabledStyle}
        >
          <View pointerEvents="none" style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('Compaction prompt')}</Text>
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {tr('Instructions for summarizing conversation context.')}
            </Text>
          </View>
          <Icon name="right" color={C.muted} />
        </Button>
      </If>
      <Button
        disabled={owner.blocked()}
        onPress={inputAction(owner.openGlobal, request)}
        accessibilityLabel={tr('Edit global instructions')}
        hoverStyle={controlHoverStyle}
        focusStyle={controlFocusStyle}
        style={{
          ...controlStyle,
          minHeight: 56,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
        disabledStyle={controlDisabledStyle}
      >
        <View pointerEvents="none" style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('Global instructions')}</Text>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr('Edit the global AGENTS.md used by the assistant.')}
          </Text>
        </View>
        <Icon name="right" color={C.muted} />
      </Button>
      <If when={owner.facts()?.workspaceInstructions === false}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {tr('Workspace instructions are off, so global instructions are not applied.')}
        </Text>
      </If>
    </View>
  );
}

function PreferenceToggle(props: {
  owner: GeneralSettingsOwner;
  request: GeneralAction;
  kind: 'instructions' | 'privacy' | 'titles';
  label: string;
  enabled: boolean;
}) {
  return (
    <Button
      selected={props.enabled}
      disabled={props.owner.disabled()}
      accessibilityLabel={tr('{label}: {state}', {
        label: props.label,
        state: props.enabled ? tr('On') : tr('Off'),
      })}
      onPress={inputAction(props.owner.toggle, { request: props.request, kind: props.kind })}
      style={{
        ...controlStyle,
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
      hoverStyle={controlHoverStyle}
      focusStyle={controlFocusStyle}
      disabledStyle={controlDisabledStyle}
    >
      <Text style={{ ...bodyTextStyle, color: C.text, flex: 1 }}>{props.label}</Text>
      <ChoiceIndicator kind="switch" checked={props.enabled} disabled={props.owner.disabled()} />
    </Button>
  );
}

function PreferenceEditor(props: { owner: GeneralSettingsOwner; request: GeneralAction }) {
  const owner = props.owner;
  const request = props.request;
  const name = () => {
    const editor = owner.editor();
    return editor?.kind === 'personalization' ? editor.displayName : '';
  };
  const prompt = () => {
    const editor = owner.editor();
    return editor?.kind === 'compaction' ? editor.prompt : '';
  };
  return (
    <View style={{ gap: 16, flex: request.kind === 'compaction' ? 1 : undefined, minHeight: 0 }}>
      <Text style={{ ...captionTextStyle, color: C.muted }}>
        {tr('Changes apply when you save this page.')}
      </Text>
      <If when={request.kind === 'personalization'}>
        <SettingsField
          label={tr('Display name')}
          value={name()}
          change={(text) => owner.editName(request, text)}
          disabled={owner.disabled()}
        />
      </If>
      <If when={request.kind === 'compaction'}>
        <SettingsEditor
          label={tr('Compaction prompt')}
          value={prompt()}
          change={(text) => owner.editPrompt(request, text)}
          disabled={owner.disabled()}
        />
        <Button
          disabled={owner.disabled()}
          accessibilityLabel={tr('Use Host default')}
          onPress={inputAction(owner.useDefault, request)}
          focusStyle={controlFocusStyle}
          style={controlStyle}
          hoverStyle={controlHoverStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Use default prompt')}</Text>
        </Button>
      </If>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button
          disabled={owner.disabled() || !owner.dirty()}
          onPress={inputAction(owner.save, request)}
          accessibilityLabel={tr('Save this preference')}
          focusStyle={{ backgroundColor: C.accentHover }}
          style={{ ...controlStyle, alignSelf: 'flex-start', backgroundColor: C.accent }}
          hoverStyle={{ backgroundColor: C.accentHover }}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...bodyTextStyle, color: C.background, fontWeight: '500' }}>
            {tr('Save')}
          </Text>
        </Button>
        <Button
          disabled={owner.busy()}
          accessibilityLabel={tr('Cancel')}
          onPress={inputAction(owner.cancel, request)}
          focusStyle={controlFocusStyle}
          style={controlStyle}
          hoverStyle={controlHoverStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Cancel')}</Text>
        </Button>
      </View>
    </View>
  );
}

function GlobalInstructionsEditor(props: { owner: GeneralSettingsOwner; request: GeneralAction }) {
  const owner = props.owner;
  const request = props.request;
  const document = owner.globalDocument;
  return (
    <View style={{ gap: 16, flex: 1, minHeight: 0 }}>
      <If when={document()}>
        <Text selectable style={{ ...captionTextStyle, color: C.muted }}>
          {document()?.basis.path}
        </Text>
        <If when={document()?.basis.exists === false}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr('This file does not exist. Saving will create it.')}
          </Text>
        </If>
        <SettingsEditor
          label={tr('Global instructions')}
          value={document()?.content ?? ''}
          change={(content) => owner.editGlobal(request, content)}
          disabled={owner.disabled()}
        />
        <If when={document()?.conflict}>
          <Text style={{ ...captionTextStyle, color: C.warning }}>
            {tr('Source changed. Your draft is preserved. Reload the source before saving again.')}
          </Text>
        </If>
      </If>
      <If when={!document() && !owner.loading()}>
        <Text style={{ ...bodyTextStyle, color: C.warning }}>
          {tr('Source unavailable. Reload to try again.')}
        </Text>
      </If>
      <If when={owner.facts()?.workspaceInstructions === false}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {tr('Workspace instructions are off, so global instructions are not applied.')}
        </Text>
      </If>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button
          disabled={owner.saveDisabled()}
          accessibilityLabel={tr('Save global instructions')}
          onPress={inputAction(owner.save, request)}
          focusStyle={{ backgroundColor: C.accentHover }}
          style={{ ...controlStyle, backgroundColor: C.accent }}
          hoverStyle={{ backgroundColor: C.accentHover }}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...bodyTextStyle, color: C.background, fontWeight: '500' }}>
            {tr('Save global instructions')}
          </Text>
        </Button>
        <Button
          disabled={owner.blocked()}
          accessibilityLabel={tr('Reload (discard edits)')}
          onPress={inputAction(owner.reloadGlobal, request)}
          focusStyle={controlFocusStyle}
          style={controlStyle}
          hoverStyle={controlHoverStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>
            {tr('Reload (discard edits)')}
          </Text>
        </Button>
        <Button
          disabled={owner.busy()}
          accessibilityLabel={tr('Cancel')}
          onPress={inputAction(owner.cancel, request)}
          focusStyle={controlFocusStyle}
          style={controlStyle}
          hoverStyle={controlHoverStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Cancel')}</Text>
        </Button>
      </View>
    </View>
  );
}
