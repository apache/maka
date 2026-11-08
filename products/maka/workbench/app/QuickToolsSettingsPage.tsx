/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { cleanup, effect, signal, Text, View } from "nsh";
import {
  SettingsRow,
  SettingsProblem,
  SettingsBody,
  SettingsSection,
  SettingsSearch,
  SettingsInlineInput,
  settingsInset,
} from "./SettingsPage";
import { Button } from "nsh/base";
import { ChoiceIndicator } from "./ChoiceIndicator";
import { Icon } from "./Icon";
import { toolIcon } from "./QuickToolIcon";
import { QuickShortcutRecorder } from "./QuickShortcutRecorder";
import {
  qt,
  setQuickLocale,
} from "../../../../plugins/application/quick-tools/shared/i18n";
import { currentLocale } from "./locale";
import {
  onSettingsChanged,
  requestSettings,
  type CommandSetting,
  type QuickSettings,
  type SettingsCommand,
} from "./quickSettings";
import { C } from "./ui";

type Plugin = QuickSettings["plugins"][number];
const pluginOrder = [
  "maka.assistant",
  "maka.links",
  "maka.applications",
  "maka.files",
  "maka.chrome",
  "maka.web.bilibili",
  "maka.clipboard",
  "maka.snippets",
  "maka.notes",
  "maka.calculator",
  "maka.symbols",
  "maka.screenshot",
  "maka.suggestions",
];
const position = (id: string) => {
  const index = pluginOrder.indexOf(id);
  return index < 0 ? pluginOrder.length : index;
};
const horizontal = {
  flexDirection: "row",
  alignItems: "center",
  gap: 8,
} as const;
const small = () => ({ fontSize: 12, lineHeight: 18, color: C.muted });
const columns = {
  ...horizontal,
  gap: 12,
  paddingLeft: 29,
  paddingRight: settingsInset,
} as const;
const aliasColumn = { width: 115, maxWidth: "27%" } as const;
const keyColumn = { width: 98, maxWidth: "25%" } as const;
function Toggle(props: {
  label: string;
  on: boolean;
  change(): void;
  disabled: boolean;
}) {
  return (
    <Button
      accessibilityLabel={props.label}
      selected={props.on}
      disabled={props.disabled}
      onPress={props.change}
      style={{ padding: 6 }}
    >
      <ChoiceIndicator kind="switch" checked={props.on} />
    </Button>
  );
}
function CommandEditor(props: {
  command: CommandSetting;
  save(field: "alias" | "shortcut", value: string): void;
}) {
  const draft = signal(props.command.alias);
  effect(() => draft.set(props.command.alias));
  const commit = () => {
    const value = draft().trim().slice(0, 80);
    draft.set(value);
    if (value !== props.command.alias) props.save("alias", value);
  };
  return (
    <View
      style={{
        ...columns,
        minHeight: 46,
        borderTopWidth: 1,
        borderColor: C.line,
      }}
    >
      <Text style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.text }}>
        {props.command.name}
      </Text>
      <View style={{ ...aliasColumn, height: 28, flexDirection: "row" }}>
        <SettingsInlineInput
          label={props.command.name + " · " + qt("别名")}
          value={draft()}
          placeholder={qt("添加别名")}
          change={(value) => draft.set(value)}
          onCommit={commit}
        />
      </View>
      <View style={keyColumn}>
        <QuickShortcutRecorder
          compact
          value={props.command.shortcut}
          onChange={(value) => props.save("shortcut", value)}
        />
      </View>
    </View>
  );
}

export function QuickToolsSettingsPage() {
  const settings = signal<QuickSettings | null>(null);
  const busy = signal(false),
    error = signal("");
  const search = signal(""),
    expanded = signal(""),
    folded = signal<string[]>([]);
  const query = () => search().trim().toLocaleLowerCase();
  const matches = (name: string) => name.toLocaleLowerCase().includes(query());
  const commands = (p: Plugin) =>
    matches(p.name)
      ? p.commands
      : p.commands.filter((c) => matches(c.name) || matches(c.alias));
  const groups = () =>
    (settings()?.plugins ?? [])
      .filter((p) => matches(p.name) || commands(p).length)
      .sort((a, b) => position(a.id) - position(b.id));
  const open = (id: string) =>
    query() ? !folded().includes(id) : expanded() === id;
  const flip = (id: string) => {
    if (query())
      folded.set(
        open(id) ? [...folded(), id] : folded().filter((i) => i !== id),
      );
    else expanded.set(open(id) ? "" : id);
  };
  let pending = 0;
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  cleanup(onSettingsChanged((value) => settings.set(value)));
  const run = async (command: SettingsCommand) => {
    pending++;
    busy.set(true);
    error.set("");
    try {
      const value = await requestSettings(command);
      if (mounted) settings.set(value);
    } catch (cause) {
      if (mounted)
        error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending--;
      if (mounted) busy.set(pending > 0);
    }
  };
  const read = () => void run({ kind: "read" });
  effect(() => {
    const locale = currentLocale();
    setQuickLocale(locale === "en" || locale === "zh-TW" ? locale : "zh-CN");
  });
  read();
  return (
    <SettingsBody>
      <If when={error()}>
        <SettingsProblem message={error()} retry={read} />
      </If>
      <If when={!settings() && !error()}>
        <Text style={{ color: C.muted }}>{qt("加载中…")}</Text>
      </If>
      <If when={settings()}>
        <SettingsSection title={qt("全局唤起")}>
          <SettingsRow
            label={qt("唤起快捷工具")}
            trailing={
              <>
                <If when={settings()?.shortcut}>
                  <View style={{ width: 80, maxWidth: "35%" }}>
                    <QuickShortcutRecorder
                      compact
                      value={settings()?.shortcut ?? ""}
                      onChange={(value) =>
                        void run({ kind: "shortcut", value })
                      }
                    />
                  </View>
                </If>
                <Toggle
                  label={qt("启用全局快捷键")}
                  on={Boolean(settings()?.shortcut)}
                  disabled={busy()}
                  change={() =>
                    void run({
                      kind: "launcher",
                      enabled: !settings()?.shortcut,
                    })
                  }
                />
              </>
            }
          />
        </SettingsSection>
        <SettingsSearch
          label={qt("搜索插件、命令或别名")}
          value={search()}
          change={(value) => {
            search.set(value);
            folded.set([]);
          }}
        />
        <SettingsSection title={qt("插件与命令")}>
          <Each of={groups()} key={(p) => p.id}>
            {(p) => (
              <View>
                <View
                  style={{
                    ...horizontal,
                    paddingRight: settingsInset,
                    borderTopWidth: 1,
                    borderColor: C.line,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <SettingsRow
                      label={p().name}
                      onPress={() => flip(p().id)}
                      leading={
                        <>
                          <Icon
                            name={open(p().id) ? "down" : "right"}
                            size={13}
                            color={C.muted}
                          />
                          {toolIcon(p().icon, p().id, true)}
                        </>
                      }
                    />
                  </View>
                  <Toggle
                    label={p().name + " · " + qt("启用")}
                    on={p().enabled}
                    disabled={busy()}
                    change={() =>
                      void run({
                        kind: "plugin",
                        id: p().id,
                        enabled: !p().enabled,
                      })
                    }
                  />
                </View>
                <If when={open(p().id)}>
                  <View>
                    <Text
                      style={{
                        ...small(),
                        marginLeft: 29,
                        marginRight: 14,
                        marginBottom: 9,
                      }}
                    >
                      {p().description}
                    </Text>
                    <If when={commands(p()).length > 0}>
                      <View
                        style={{
                          ...columns,
                          paddingVertical: 4,
                          backgroundColor: C.surface,
                        }}
                      >
                        <Text style={{ ...small(), flex: 1 }}>
                          {qt("命令")}
                        </Text>
                        <Text style={{ ...small(), ...aliasColumn }}>
                          {qt("别名")}
                        </Text>
                        <Text style={{ ...small(), ...keyColumn }}>
                          {qt("快捷键")}
                        </Text>
                      </View>
                    </If>
                    <Each of={commands(p())} key={(c) => c.id}>
                      {(c) => (
                        <CommandEditor
                          command={c()}
                          save={(field, value) =>
                            void run({
                              kind: "item",
                              plugin: p().id,
                              id: c().id,
                              field,
                              value,
                            })
                          }
                        />
                      )}
                    </Each>
                  </View>
                </If>
              </View>
            )}
          </Each>
          <If when={!groups().length}>
            <SettingsRow label={qt("没有匹配项")} />
          </If>
        </SettingsSection>
      </If>
    </SettingsBody>
  );
}
