/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { cleanup, effect, host, signal, Text, View } from 'nsh';
import {
  SettingsBody,
  SettingsSection,
  SettingsSwitch,
  SettingsRow,
  SettingsProblem,
} from './SettingsPage';
import { QuickShortcutRecorder } from './QuickShortcutRecorder';
import { qt, setQuickLocale } from '../../../../plugins/application/quick-tools/shared/i18n';
import { currentLocale } from './locale';
import {
  onSettingsChanged,
  requestSettings,
  type QuickSettings,
  type SettingsCommand,
} from './quickSettings';
import { C } from './ui';

export function QuickToolsSettingsPage() {
  const settings = signal<QuickSettings | null>(null);
  const busy = signal(false),
    error = signal('');
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  cleanup(onSettingsChanged((value) => settings.set(value)));
  const run = async (command: SettingsCommand) => {
    if (busy()) return;
    busy.set(true);
    error.set('');
    try {
      const value = await requestSettings(command);
      if (mounted) settings.set(value);
    } catch (cause) {
      if (mounted) error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted) busy.set(false);
    }
  };
  const read = () => void run({ kind: 'read' });
  effect(() => {
    const locale = currentLocale();
    setQuickLocale(locale === 'en' || locale === 'zh-TW' ? locale : 'zh-CN');
  });
  read();
  return (
    <SettingsBody>
      <If when={error()}>
        <SettingsProblem message={error()} retry={read} />
      </If>
      <If when={!settings() && !error()}>
        <Text style={{ color: C.muted }}>{qt('加载中…')}</Text>
      </If>
      <If when={settings()}>
        <SettingsSection title={qt('全局快捷键')}>
          <SettingsSwitch
            label={qt('启用快捷键')}
            checked={Boolean(settings()?.shortcut)}
            disabled={busy()}
            onPress={() => void run({ kind: 'launcher', enabled: !settings()?.shortcut })}
          />
          <SettingsRow
            label={qt('快捷键')}
            trailing={
              <View style={{ width: 200, maxWidth: '50%' }}>
                <QuickShortcutRecorder
                  value={settings()?.shortcut ?? ''}
                  onChange={(value) => void run({ kind: 'shortcut', value })}
                />
              </View>
            }
          />
        </SettingsSection>
        <SettingsSection title={qt('插件')}>
          <Each of={settings()?.plugins ?? []} key={(item) => item.id}>
            {(item) => (
              <SettingsSwitch
                label={item().name}
                description={item().description}
                checked={item().enabled}
                disabled={busy()}
                onPress={() =>
                  void run({
                    kind: 'plugin',
                    id: item().id,
                    enabled: !item().enabled,
                  })
                }
              />
            )}
          </Each>
        </SettingsSection>
        <SettingsSection>
          <SettingsRow
            label={qt('打开快捷工具设置')}
            opens
            onPress={() => {
              void host
                .call('quickTools.show', { settings: true })
                .catch((cause) => error.set(String(cause)));
            }}
          />
        </SettingsSection>
      </If>
    </SettingsBody>
  );
}
