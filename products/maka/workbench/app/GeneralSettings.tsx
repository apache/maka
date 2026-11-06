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

import { inputAction, platform, signal, View } from 'nsh';
import { Button, Slider } from 'nsh/base';
import type { LanguagePreference } from '../../../../packages/plugin-sdk/src/index.js';
import { tr } from './locale';
import {
  assistantLanguages,
  type GeneralAction,
  type GeneralSettingsOwner,
} from './generalSettingsState.ts';
import { UiScaleSettings } from './UiScaleSettings';
import { PredictionSettings } from './PredictionSettings';
import { uiScale } from './uiScale';
import { appearance, colorThemes, paletteIds, textSizes } from './appearance';
import { accentSwatches, paletteTokens, presetRecipes, type PaletteId } from './colorPalette';
import { LoadingIndicator } from './Loading';
import {
  SettingsBody,
  SettingsButton,
  SettingsFormFooter,
  SettingsInput,
  SettingsProblem,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  SettingsTextArea,
} from './SettingsPage';
import { C, defaultColors, isDark } from './ui';

export function GeneralSettings(props: { owner: GeneralSettingsOwner }) {
  const owner = props.owner;
  return (
    <Each of={[owner.action()]} key={(request) => JSON.stringify(request)}>
      {(action) => {
        const request = action();
        if (request.kind === 'root') return <GeneralRoot owner={owner} request={request} />;
        if (request.kind === 'globalInstructions')
          return <GlobalInstructionsEditor owner={owner} request={request} />;
        if (request.kind === 'predictions')
          return <PredictionSettings owner={owner} request={request} />;
        return <PreferenceEditor owner={owner} request={request} />;
      }}
    </Each>
  );
}

function GeneralRoot(props: { owner: GeneralSettingsOwner; request: GeneralAction }) {
  const owner = props.owner;
  const request = props.request;
  const facts = owner.facts;
  const toggle = (kind: 'instructions' | 'privacy' | 'titles' | 'predictions') =>
    inputAction(owner.toggle, { request, kind });
  const open = (kind: 'personalization' | 'compaction' | 'shell' | 'predictions') =>
    inputAction(owner.open, { request, kind });
  return (
    <SettingsBody>
      <SettingsSection title={tr('Appearance & language')}>
        <If when={appearance.supported}>
          <AppearanceRows />
        </If>
        {/* A terminal without pixel scaling is sized by its font; a desktop window has neither. */}
        <If when={uiScale.supported || platform.isTerminal}>
          <UiScaleSettings />
        </If>
        <If when={facts()}>
          <SettingsSelect
            label={tr('Language')}
            description={tr('Language used by the interface and assistant.')}
            value={facts()?.language ?? 'auto'}
            disabled={owner.disabled()}
            choices={assistantLanguages().map((item) => ({ value: item.value, title: item.label }))}
            change={(value) => owner.language({ request, preference: value as LanguagePreference })}
          />
        </If>
      </SettingsSection>
      <If
        when={facts()}
        else={
          <If when={owner.loading()} else={<SettingsProblem retry={owner.refresh} />}>
            <LoadingIndicator label={tr('Reading preferences…')} />
          </If>
        }
      >
        <SettingsSection title={tr('Conversations')}>
          <SettingsSwitch
            label={tr('Message predictions')}
            description={tr('Suggest your next message from the conversation.')}
            checked={facts()?.predictions.enabled ?? false}
            disabled={owner.disabled()}
            onPress={toggle('predictions')}
          />
          <SettingsRow
            label={tr('Prediction settings…')}
            accessibilityLabel={tr('Configure message predictions')}
            opens
            disabled={owner.disabled()}
            onPress={open('predictions')}
          />
          <SettingsSwitch
            label={tr('Workspace instructions')}
            checked={facts()?.workspaceInstructions ?? false}
            disabled={owner.disabled()}
            onPress={toggle('instructions')}
          />
          <SettingsSwitch
            label={tr('Incognito mode')}
            checked={facts()?.incognitoActive ?? false}
            disabled={owner.disabled()}
            onPress={toggle('privacy')}
          />
          <SettingsSwitch
            label={tr('Automatic shell titles')}
            checked={facts()?.shell.titles ?? false}
            disabled={owner.disabled()}
            onPress={toggle('titles')}
          />
          <If when={platform.os === 'windows'}>
            <SettingsRow
              label={tr('Bash tool shell')}
              description={
                facts()?.shell.preference === 'git_bash' ? tr('Git Bash') : tr('Automatic')
              }
              opens
              disabled={owner.disabled()}
              onPress={open('shell')}
            />
          </If>
        </SettingsSection>
      </If>
      <SettingsSection
        title={tr('Instructions')}
        note={
          facts()?.workspaceInstructions === false
            ? tr('Workspace instructions are off, so global instructions are not applied.')
            : undefined
        }
      >
        <SettingsRow
          label={tr('Global instructions')}
          description={tr('Edit the global AGENTS.md used by the assistant.')}
          accessibilityLabel={tr('Edit global instructions')}
          opens
          disabled={owner.blocked()}
          onPress={inputAction(owner.openGlobal, request)}
        />
        <If when={facts()}>
          <SettingsRow
            label={tr('Compaction prompt')}
            description={tr('Instructions for summarizing conversation context.')}
            accessibilityLabel={tr('Edit compaction prompt')}
            opens
            disabled={owner.disabled()}
            onPress={open('compaction')}
          />
          <SettingsRow
            label={tr('Personalization')}
            description={facts()?.displayName || tr('Display name')}
            accessibilityLabel={tr('Edit personalization')}
            opens
            disabled={owner.disabled()}
            onPress={open('personalization')}
          />
        </If>
      </SettingsSection>
    </SettingsBody>
  );
}

function PreferenceEditor(props: { owner: GeneralSettingsOwner; request: GeneralAction }) {
  const owner = props.owner;
  const request = props.request;
  const shellEditor = () => {
    const editor = owner.editor();
    return editor?.kind === 'shell' ? editor : null;
  };
  const name = () => {
    const editor = owner.editor();
    return editor?.kind === 'personalization' ? editor.displayName : '';
  };
  const prompt = () => {
    const editor = owner.editor();
    return editor?.kind === 'compaction' ? editor.prompt : '';
  };
  return (
    <SettingsBody
      footer={
        <SettingsFormFooter
          saveLabel={tr('Save this preference')}
          canSave={!owner.disabled() && owner.dirty()}
          busy={owner.busy()}
          save={inputAction(owner.save, request)}
          cancel={inputAction(owner.cancel, request)}
        />
      }
    >
      <If when={request.kind === 'shell'}>
        <SettingsSection
          note={tr(
            'Automatic uses PowerShell first on Windows. Git Bash overrides only this Runtime Host.',
          )}
        >
          <SettingsSelect
            label={tr('Bash tool shell')}
            value={shellEditor()?.preference ?? 'auto'}
            disabled={owner.disabled()}
            choices={[
              { value: 'auto', title: tr('Automatic') },
              { value: 'git_bash', title: tr('Git Bash') },
            ]}
            change={(value) =>
              owner.editShell({
                request,
                change: { preference: value as 'auto' | 'git_bash' },
              })
            }
          />
          <If when={shellEditor()?.preference === 'git_bash'}>
            <SettingsInput
              label={tr('Git Bash executable')}
              value={shellEditor()?.executable ?? ''}
              change={(text) => owner.editShell({ request, change: { executable: text } })}
              disabled={owner.disabled()}
            />
          </If>
        </SettingsSection>
      </If>
      <If when={request.kind === 'personalization'}>
        <SettingsSection>
          <SettingsInput
            label={tr('Display name')}
            value={name()}
            change={(text) => owner.editName(request, text)}
            disabled={owner.disabled()}
            autoFocus
          />
        </SettingsSection>
      </If>
      <If when={request.kind === 'compaction'}>
        <SettingsSection
          trailing={
            <SettingsButton
              label={tr('Use default prompt')}
              accessibilityLabel={tr('Use Host default')}
              tone="quiet"
              disabled={owner.disabled()}
              onPress={inputAction(owner.useDefault, request)}
            />
          }
        >
          <SettingsTextArea
            label={tr('Compaction prompt')}
            value={prompt()}
            lines={16}
            change={(text) => owner.editPrompt(request, text)}
            disabled={owner.disabled()}
          />
        </SettingsSection>
      </If>
    </SettingsBody>
  );
}

function GlobalInstructionsEditor(props: { owner: GeneralSettingsOwner; request: GeneralAction }) {
  const owner = props.owner;
  const request = props.request;
  const document = owner.globalDocument;
  return (
    <SettingsBody
      footer={
        <SettingsFormFooter
          saveLabel={tr('Save global instructions')}
          canSave={!owner.saveDisabled()}
          busy={owner.busy()}
          save={inputAction(owner.save, request)}
          cancel={inputAction(owner.cancel, request)}
          extra={
            <If when={owner.dirty() || document()?.conflict}>
              <SettingsButton
                label={tr('Reload (discard edits)')}
                tone="quiet"
                disabled={owner.blocked()}
                onPress={inputAction(owner.reloadGlobal, request)}
              />
            </If>
          }
        />
      }
    >
      <If when={owner.loading()}>
        <LoadingIndicator label={tr('Reading global instructions…')} />
      </If>
      <If when={document()}>
        <SettingsSection
          title={document()?.basis.path}
          note={
            document()?.conflict
              ? tr(
                  'Source changed. Your draft is preserved. Reload the source before saving again.',
                )
              : document()?.basis.exists === false
                ? tr('This file does not exist. Saving will create it.')
                : owner.facts()?.workspaceInstructions === false
                  ? tr('Workspace instructions are off, so global instructions are not applied.')
                  : undefined
          }
        >
          <SettingsTextArea
            label={tr('Global instructions')}
            value={document()?.content ?? ''}
            lines={18}
            monospace
            change={(content) => owner.editGlobal(request, content)}
            disabled={owner.disabled()}
          />
        </SettingsSection>
      </If>
      <If when={!document() && !owner.loading()}>
        <SettingsProblem retry={inputAction(owner.reloadGlobal, request)} />
      </If>
    </SettingsBody>
  );
}

const themeLabel = (theme: (typeof colorThemes)[number]) =>
  ({ system: tr('Match system'), light: tr('Light'), dark: tr('Dark') })[theme];
const textSizeLabel = (scale: number) =>
  scale < 1 ? tr('Small') : scale === 1 ? tr('Default') : scale < 1.2 ? tr('Large') : tr('Larger');
const paletteLabel = (id: PaletteId) =>
  ({
    default: tr('Default'),
    mist: tr('Mist'),
    sage: tr('Sage'),
    sand: tr('Sand'),
    burgundy: tr('Burgundy'),
    graphite: tr('Graphite'),
    custom: tr('Custom'),
  })[id];

/** A palette's background, raised surface and accent, in the appearance in effect. */
const paletteSwatch = (id: PaletteId) => {
  const dark = isDark();
  const recipe =
    id === 'default' ? null : id === 'custom' ? appearance.custom() : presetRecipes[id];
  const colors = recipe ? paletteTokens(recipe, dark) : defaultColors(dark);
  return [colors.background, colors.raised, colors.accent];
};

function Swatch(props: { id: PaletteId }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        borderRadius: 4,
        borderWidth: 1,
        borderColor: C.line,
        overflow: 'hidden',
      }}
    >
      <Each of={paletteSwatch(props.id)} key={(_, index) => String(index)}>
        {(color) => <View style={{ width: 8, height: 14, backgroundColor: color() }} />}
      </Each>
    </View>
  );
}

function AppearanceRows() {
  return (
    <>
      <SettingsSelect
        label={tr('Appearance')}
        value={appearance.theme()}
        choices={colorThemes.map((theme) => ({ value: theme, title: themeLabel(theme) }))}
        change={(value) => appearance.chooseTheme(value as (typeof colorThemes)[number])}
      />
      <SettingsSelect
        label={tr('Palette')}
        value={appearance.palette()}
        preview={<Swatch id={appearance.palette()} />}
        choices={paletteIds.map((id) => ({ value: id, title: paletteLabel(id) }))}
        change={(value) => appearance.choosePalette(value as PaletteId)}
      />
      <If when={appearance.palette() === 'custom'}>
        <CustomPalette />
      </If>
      <SettingsSelect
        label={tr('Text size')}
        value={String(appearance.textSize())}
        choices={textSizes.map((scale) => ({ value: String(scale), title: textSizeLabel(scale) }))}
        change={(value) => appearance.chooseTextSize(Number(value))}
      />
    </>
  );
}

const sliderLook = () => ({
  indicatorStyle: { height: 4, borderRadius: 2, backgroundColor: C.line },
  rangeStyle: { borderRadius: 2, backgroundColor: C.accent },
  thumbStyle: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: C.background,
    borderWidth: 2,
    borderColor: C.accent,
  },
});

/** The custom palette: an accent, and the hue and amount of it in the grays. */
function CustomPalette() {
  const typed = signal(appearance.custom().accent);
  const chooseAccent = (accent: string) => {
    typed.set(accent);
    appearance.changeCustom({ accent }, true);
  };
  return (
    <>
      <SettingsRow
        label={tr('Accent')}
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
            <Each of={accentSwatches} key={(color) => color}>
              {(color) => (
                <Button
                  accessibilityLabel={`${tr('Accent')}: ${color()}`}
                  selected={appearance.custom().accent === color()}
                  onPress={inputAction(chooseAccent, color())}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    borderWidth: 2,
                    borderColor: appearance.custom().accent === color() ? C.text : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  focusStyle={{ borderColor: C.accent }}
                >
                  <View
                    style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: color() }}
                  />
                </Button>
              )}
            </Each>
          </View>
        }
      />
      <SettingsInput
        label={tr('Accent color (#rrggbb)')}
        value={typed()}
        placeholder="#4a6890"
        change={(value) => {
          typed.set(value);
          const accent = value.trim().startsWith('#') ? value.trim() : `#${value.trim()}`;
          appearance.changeCustom({ accent: accent.toLowerCase() }, true);
        }}
      />
      <SettingsRow
        label={tr('Background hue')}
        trailing={
          <View style={{ width: '50%' }}>
            <Slider
              value={appearance.custom().hue}
              min={0}
              max={359}
              step={1}
              accessibilityLabel={tr('Background hue')}
              onChange={({ value }) => appearance.changeCustom({ hue: value as number }, false)}
              onChangeEnd={({ value }) => appearance.changeCustom({ hue: value as number }, true)}
              indicatorStyle={sliderLook().indicatorStyle}
              rangeStyle={sliderLook().rangeStyle}
              thumbStyle={sliderLook().thumbStyle}
            />
          </View>
        }
      />
      <SettingsRow
        label={tr('Background tint')}
        trailing={
          <View style={{ width: '50%' }}>
            <Slider
              value={Math.round(appearance.custom().tint * 100)}
              min={0}
              max={100}
              step={5}
              accessibilityLabel={tr('Background tint')}
              onChange={({ value }) =>
                appearance.changeCustom({ tint: (value as number) / 100 }, false)
              }
              onChangeEnd={({ value }) =>
                appearance.changeCustom({ tint: (value as number) / 100 }, true)
              }
              indicatorStyle={sliderLook().indicatorStyle}
              rangeStyle={sliderLook().rangeStyle}
              thumbStyle={sliderLook().thumbStyle}
            />
          </View>
        }
      />
    </>
  );
}
