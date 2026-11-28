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

import { dictationPreferences as dictation } from './dictationPreferences';
import { Image, inputAction, platform, signal, Text, View } from 'nsh';
import { Button, Menu, MenuItem } from 'nsh/base';
import type {
  LanguagePreference,
  ProfileAvatar as Avatar,
  SettingsAssistantPreferences,
} from '../../../../packages/plugin-sdk/src/index.js';
import { tr, type MessageKey } from './locale';
import {
  assistantLanguages,
  type GeneralAction,
  type GeneralSettingsOwner,
} from './generalSettingsState.ts';
import { ComposerToolbarSettings } from './ComposerToolbarSettings';
import { composerToolbar } from './composerToolbar';
import { appUpdater } from './appUpdater';
import { UiScaleSettings } from './UiScaleSettings';
import { PredictionSettings } from './PredictionSettings';
import { uiScale } from './uiScale';
import {
  appearance,
  colorThemes,
  maxTextSize,
  minTextSize,
  trayIcons,
  type TrayIcon,
} from './appearance';
import { trayIconArtwork } from './trayIcon';
import { unchanged } from './look';
import { lookLabel, ThemeEditor, themeLabel } from './ThemeEditor';
import { LoadingIndicator, SettingsSkeleton } from './Loading';
import { ProfileAvatar } from './ProfileAvatar';
import { Icon } from './Icon';
import {
  SettingsBody,
  SettingsButton,
  SettingsDiscard,
  SettingsFormFooter,
  SettingsInput,
  SettingsProblem,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  SettingsTextArea,
} from './SettingsPage';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  floatingStyle,
  IconButton,
  menuRowHoverStyle,
  menuRowStyle,
  quietFocusStyle,
} from './ui';

const avatarChoices = [
  { avatar: null, label: 'Default avatar' },
  { avatar: 'blue', label: 'Blue avatar' },
  { avatar: 'green', label: 'Green avatar' },
  { avatar: 'rose', label: 'Rose avatar' },
  { avatar: 'amber', label: 'Amber avatar' },
] satisfies { avatar: Avatar | null; label: MessageKey }[];

export function GeneralSettings(props: { owner: GeneralSettingsOwner; addConnection: () => void }) {
  const owner = props.owner;
  return (
    <If
      when={!owner.discarding.asking()}
      else={<SettingsDiscard onDiscard={owner.discarding.discard} onKeep={owner.discarding.keep} />}
    >
      <Each of={[owner.action()]} key={(request) => JSON.stringify(request)}>
        {(action) => {
          const request = action();
          if (request.kind === 'root') return <GeneralRoot owner={owner} request={request} />;
          if (request.kind === 'globalInstructions')
            return <GlobalInstructionsEditor owner={owner} request={request} />;
          if (request.kind === 'dictation')
            return <DictationSettings addConnection={props.addConnection} />;
          if (request.kind === 'theme') return <ThemeEditor />;
          if (request.kind === 'predictions')
            return <PredictionSettings owner={owner} request={request} />;
          return <PreferenceEditor owner={owner} request={request} />;
        }}
      </Each>
    </If>
  );
}

function GeneralRoot(props: { owner: GeneralSettingsOwner; request: GeneralAction }) {
  const owner = props.owner;
  const request = props.request;
  const facts = owner.facts;
  if (platform.os === 'macos' && platform.idiom !== 'terminal')
    void dictation
      .initialize()
      .then(() => (dictation.enabled() ? dictation.refresh() : undefined))
      .catch((e) => dictation.error.set(String(e)));
  const toggle = (kind: 'instructions' | 'titles' | 'predictions') =>
    inputAction(owner.toggle, { request, kind });
  const open = (kind: 'personalization' | 'compaction' | 'shell' | 'predictions') =>
    inputAction(owner.open, { request, kind });
  return (
    <SettingsBody>
      <SettingsSection>
        <SettingsRow
          label={tr('Personalization')}
          description={facts()?.displayName.trim() || undefined}
          accessibilityLabel={tr('Edit personalization')}
          opens
          disabled={owner.disabled()}
          onPress={open('personalization')}
        />
      </SettingsSection>
      <SettingsSection title={tr('Appearance & language')}>
        <If when={appearance.supported}>
          <AppearanceRows openTheme={inputAction(owner.openTheme, request)} />
        </If>
        {/* A terminal without pixel scaling is sized by its font; a desktop window has neither. */}
        <If when={uiScale.supported || platform.idiom === 'terminal'}>
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
      <If when={composerToolbar.supported}>
        <ComposerToolbarSettings />
      </If>
      <If
        when={facts()}
        else={
          <If when={owner.loading()} else={<SettingsProblem retry={owner.refresh} />}>
            <SettingsSkeleton padded={false} rows={3} label={tr('Reading preferences…')} />
          </If>
        }
      >
        <SettingsSection title={tr('Conversations')}>
          <If when={platform.os === 'macos' && platform.idiom !== 'terminal'}>
            <SettingsRow
              label={tr('Dictation')}
              description={dictation.description()}
              opens
              onPress={inputAction(owner.open, { request, kind: 'dictation' as const })}
            />
          </If>
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
          <SettingsSelect
            label={tr('Default sandbox policy')}
            description={tr('Applied to new conversations.')}
            value={facts()?.defaultSandboxMode ?? 'workspace-write'}
            disabled={owner.disabled()}
            choices={[
              { value: 'read-only', title: tr('Read only') },
              { value: 'workspace-write', title: tr('Workspace write') },
              { value: 'danger-full-access', title: tr('Full access · Sandbox off') },
            ]}
            change={(mode) =>
              owner.sandboxMode({
                request,
                mode: mode as SettingsAssistantPreferences['defaultSandboxMode'],
              })
            }
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
        </If>
      </SettingsSection>
      <UpdatesSection />
    </SettingsBody>
  );
}

function DictationSettings(props: { addConnection(): void }) {
  if (dictation.enabled()) void dictation.refresh().catch((e) => dictation.error.set(String(e)));
  return (
    <SettingsBody>
      <SettingsSection>
        <SettingsSwitch
          label={tr('Enable dictation')}
          description={tr('Use the microphone in chats and Quick Tools.')}
          checked={dictation.enabled()}
          disabled={dictation.busy()}
          onPress={() => void dictation.save('enabled', String(!dictation.enabled()))}
        />
      </SettingsSection>
      <If when={dictation.enabled()}>
        <SettingsSection>
          <SettingsSwitch
            label={tr('Listen when Quick Tools opens')}
            checked={dictation.listenOnOpen()}
            disabled={dictation.busy()}
            onPress={() => void dictation.save('listenOnOpen', String(!dictation.listenOnOpen()))}
          />
        </SettingsSection>
        <SettingsSection note={tr('Dictation uses the API key from this connection.')}>
          <SettingsRow
            label={tr('Transcription service')}
            trailing={<Text style={{ ...bodyTextStyle, color: C.secondary }}>DeepSeek</Text>}
          />
          <If
            when={dictation.connections().length > 0}
            else={
              <SettingsRow
                label={tr('Add a DeepSeek connection')}
                description={dictation.useLegacy() ? tr('Saved dictation key') : undefined}
                opens
                onPress={props.addConnection}
              />
            }
          >
            <SettingsSelect
              label={tr('Model connection')}
              value={
                dictation.current()?.basis.connectionId ?? (dictation.useLegacy() ? 'legacy' : '')
              }
              choices={[
                ...dictation
                  .connections()
                  .map((c) => ({ value: c.basis.connectionId, title: c.name })),
                ...(dictation.legacy()
                  ? [{ value: 'legacy', title: tr('Saved dictation key') }]
                  : []),
              ]}
              placeholder={tr('Choose a model connection')}
              disabled={dictation.busy()}
              change={(value) => void dictation.save('connection', value)}
            />
          </If>
        </SettingsSection>
      </If>
      <If when={!!dictation.error()}>
        <SettingsProblem message={dictation.error()} />
      </If>
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
  const avatar = () => {
    const editor = owner.editor();
    return editor?.kind === 'personalization' ? editor.avatar : null;
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
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, gap: 4 }}>
            <Menu
              align="start"
              offset={6}
              margin={8}
              popupStyle={floatingStyle()}
              trigger={
                <Button
                  accessibilityLabel={tr('Change avatar')}
                  disabled={owner.disabled()}
                  style={{ padding: 4, borderRadius: 24 }}
                  hoverStyle={{ backgroundColor: C.cardRaised }}
                  focusStyle={quietFocusStyle()}
                >
                  <ProfileAvatar name={name()} avatar={avatar()} size={40} />
                  <View
                    style={{
                      position: 'absolute',
                      right: 0,
                      bottom: 0,
                      padding: 3,
                      borderRadius: 9,
                      backgroundColor: C.cardRaised,
                      pointerEvents: 'none',
                    }}
                  >
                    <Icon name="edit" size={11} color={C.secondary} />
                  </View>
                </Button>
              }
            >
              <Each of={avatarChoices} key={(item) => item.label}>
                {(item) => (
                  <MenuItem
                    accessibilityLabel={tr(item().label)}
                    onSelect={() => owner.editAvatar(request, item().avatar)}
                    style={{ ...menuRowStyle(), minWidth: 160, gap: 8 }}
                    hoverStyle={menuRowHoverStyle()}
                  >
                    <ProfileAvatar name={name()} avatar={item().avatar} size={24} />
                    <Text style={{ ...bodyTextStyle, color: C.text, flex: 1 }}>
                      {tr(item().label)}
                    </Text>
                    <If when={item().avatar === avatar()}>
                      <Icon name="check" size={14} color={C.accentText} />
                    </If>
                  </MenuItem>
                )}
              </Each>
            </Menu>
            <View style={{ flex: 1, minWidth: 0 }}>
              <SettingsInput
                label={tr('Display name')}
                value={name()}
                change={(text) => owner.editName(request, text)}
                disabled={owner.disabled()}
                autoFocus
              />
            </View>
          </View>
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
      <If when={owner.loading() && !document()}>
        <SettingsSkeleton padded={false} rows={2} label={tr('Reading global instructions…')} />
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

function UpdatesSection() {
  appUpdater.init();
  const channelLabel = () => {
    switch (appUpdater.snapshot()?.channel) {
      case 'nightly':
        return tr('Nightly (unofficial developer build)');
      case 'release':
        return tr('Release');
      default:
        return tr('Development');
    }
  };
  const description = () => {
    const state = appUpdater.snapshot();
    if (!state) return undefined;
    if (state.channel === 'dev') {
      return tr('Automatic updates are disabled for local development builds.');
    }
    const version = state.available?.version ?? '';
    switch (state.status) {
      case 'checking':
        return tr('Checking for updates…');
      case 'available':
        return state.canInstall
          ? tr('Version {version} is available to download.', { version })
          : tr('Version {version} is available for manual download.', { version });
      case 'downloading': {
        const pct = appUpdater.progressPercent();
        return pct === null
          ? tr('Downloading update {version}…', { version })
          : tr('Downloading update {version}… {percent}%', { version, percent: String(pct) });
      }
      case 'ready':
        return tr(
          'Update {version} is ready. Maka Host will restart to apply it; active runs resume automatically.',
          { version },
        );
      case 'installing':
        return tr('Stopping Maka Host and applying update…');
      case 'upToDate':
        return tr('You are on the latest build for this channel.');
      case 'error':
        return undefined;
      default:
        return tr('Check for updates on this channel.');
    }
  };
  const errorMessage = () => {
    const state = appUpdater.snapshot();
    if (!state || state.channel === 'dev') return undefined;
    if (state.status === 'error') return state.error ?? tr('Update check failed.');
    if (state.status === 'ready' && state.error) return state.error;
    return undefined;
  };
  const busy = () => {
    const status = appUpdater.snapshot()?.status;
    return status === 'checking' || status === 'downloading' || status === 'installing';
  };
  return (
    <If when={appUpdater.snapshot() !== null}>
      <SettingsSection title={tr('Updates')}>
        <SettingsRow
          label={`${appUpdater.snapshot()?.currentVersion ?? ''} · ${channelLabel()}`}
          description={description()}
          detail={
            <If when={!!errorMessage()}>
              <Text style={{ ...captionTextStyle, color: C.danger }}>{errorMessage()}</Text>
            </If>
          }
          trailing={
            <If when={appUpdater.snapshot()?.channel !== 'dev'}>
              <If when={busy()}>
                <LoadingIndicator label={description()} />
              </If>
              <If when={appUpdater.snapshot()?.status === 'ready'}>
                <SettingsButton
                  tone="primary"
                  label={tr('Restart to update')}
                  onPress={() => void appUpdater.installAndRestart()}
                />
              </If>
              <If when={appUpdater.snapshot()?.status === 'available'}>
                <If
                  when={appUpdater.snapshot()?.canInstall === true}
                  else={
                    <SettingsButton
                      tone="primary"
                      label={tr('Open download')}
                      onPress={() => void appUpdater.openDownload()}
                    />
                  }
                >
                  <SettingsButton
                    tone="primary"
                    label={tr('Download update')}
                    onPress={() => void appUpdater.download()}
                  />
                </If>
              </If>
              <If
                when={
                  appUpdater.snapshot()?.status === 'idle' ||
                  appUpdater.snapshot()?.status === 'upToDate' ||
                  appUpdater.snapshot()?.status === 'error'
                }
              >
                <SettingsButton
                  label={tr('Check for updates')}
                  onPress={() => void appUpdater.check()}
                />
              </If>
            </If>
          }
        />
      </SettingsSection>
    </If>
  );
}

function AppearanceRows(props: { openTheme(): void }) {
  return (
    <>
      <SettingsSelect
        label={tr('Appearance')}
        value={appearance.theme()}
        choices={colorThemes.map((theme) => ({ value: theme, title: themeLabel(theme) }))}
        change={(value) => appearance.chooseTheme(value as (typeof colorThemes)[number])}
      />
      <SettingsRow
        label={tr('Theme')}
        description={
          appearance.look() && !unchanged(appearance.shown())
            ? tr('Based on {preset} · Modified', { preset: lookLabel(appearance.shown().base) })
            : lookLabel(appearance.shown().base)
        }
        accessibilityLabel={tr('Edit theme')}
        opens
        onPress={props.openTheme}
      />
      <SettingsRow
        label={tr('Text size')}
        trailing={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <IconButton
              label={tr('Smaller text')}
              icon="minus"
              disabled={appearance.fontSize() <= minTextSize}
              onPress={() => appearance.stepTextSize(-1)}
            />
            <Text
              style={{
                ...captionTextStyle,
                minWidth: 24,
                textAlign: 'center',
                color: C.text,
                fontVariant: ['tabular-nums'],
              }}
            >
              {String(appearance.fontSize())}
            </Text>
            <IconButton
              label={tr('Larger text')}
              icon="plus"
              disabled={appearance.fontSize() >= maxTextSize}
              onPress={() => appearance.stepTextSize(1)}
            />
          </View>
        }
      />
      <SettingsSelect
        label={trayIconRowLabel()}
        value={appearance.trayIcon()}
        preview={<If when={trayIconShown()}>{(icon) => <TrayArtwork icon={icon()} />}</If>}
        choicePreview={(value) =>
          value === 'none' ? (
            <View style={{ width: 18, height: 18 }} />
          ) : (
            <TrayArtwork icon={value as ShownTrayIcon} />
          )
        }
        choices={trayIcons.map((icon) => ({ value: icon, title: trayIconLabel(icon) }))}
        change={(value) => appearance.chooseTrayIcon(value as TrayIcon)}
      />
    </>
  );
}

type ShownTrayIcon = Exclude<TrayIcon, 'none'>;
const trayIconShown = (): ShownTrayIcon | null => {
  const icon = appearance.trayIcon();
  return icon === 'none' ? null : icon;
};
function TrayArtwork(props: { icon: ShownTrayIcon }) {
  return (
    <Image
      src={trayIconArtwork[props.icon]}
      style={[{ width: 18, height: 18, tintColor: C.text }, { pointerEvents: 'none' }]}
    />
  );
}

function trayIconRowLabel() {
  return platform.os === 'macos' ? tr('Menu bar icon') : tr('System tray icon');
}

function trayIconLabel(icon: TrayIcon) {
  if (icon === 'line') return tr('Thin line');
  if (icon === 'bold') return tr('Bold line');
  if (icon === 'none') return tr('Hidden');
  return tr('Solid tile');
}
