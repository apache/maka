import { keymap, mount, signal, Text, View } from "nsh";
import { Command, type CommandItem, type CommandRef } from "nsh/base";
import {
  CommandEmpty,
  CommandHeading,
  CommandRow,
  commandClasses,
  desktop,
  Icon,
  type IconName,
  Log,
  Panel,
  Split,
  ui,
  wide,
} from "./palette";

// A command palette: sections with headings, shortcuts shown as the
// platform writes them, a disabled command, the appearance in effect
// checked, keywords that find a command by another word. The command owns
// the filtering, the highlight, the keys and the semantics; every pixel is
// `commandClasses` and `CommandRow`.
const icons: Record<string, IconName> = {
  new: "plus",
  open: "folder",
  save: "download",
  share: "share",
  find: "search",
  replace: "replace",
  terminal: "terminal",
  sidebar: "sidebar",
  dark: "moon",
  light: "sun",
  docs: "document",
  feedback: "chat",
};

const appearance = signal<"dark" | "light">("dark");
const highlighted = signal<string | null>(null);
const query = signal("");
const events = signal<string[]>([]);
const log = (line: string) => events.set([line, ...events()].slice(0, 4));
let palette: CommandRef | undefined;

const items = (): CommandItem[] => [
  { id: "new", label: "New File", group: "File", shortcut: "mod+n" },
  { id: "open", label: "Open Folder…", group: "File", shortcut: "mod+o" },
  { id: "save", label: "Save All", group: "File", shortcut: "mod+alt+s" },
  { id: "share", label: "Share Project", group: "File", disabled: true },
  { id: "find", label: "Find in Files", group: "Edit", shortcut: "mod+shift+f", keywords: ["search", "grep"] },
  { id: "replace", label: "Replace in Files", group: "Edit", shortcut: "mod+shift+h" },
  { id: "terminal", label: "Toggle Terminal", group: "View", shortcut: "ctrl+j", keywords: ["console", "shell"] },
  { id: "sidebar", label: "Toggle Sidebar", group: "View", shortcut: "mod+b" },
  { id: "dark", label: "Dark Appearance", group: "View", keywords: ["theme"], checked: appearance() === "dark" },
  { id: "light", label: "Light Appearance", group: "View", keywords: ["theme"], checked: appearance() === "light" },
  { id: "docs", label: "Open Documentation", group: "Help", keywords: ["guide", "manual"] },
  { id: "feedback", label: "Send Feedback", group: "Help" },
];

function App() {
  keymap.bind("mod+k", () => palette?.focus());
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>command</Text>
      <Text style={{ color: ui().muted }}>
        {desktop
          ? `Type to filter, the arrows to move, Return to run, Escape to clear; ${keymap.label("mod+k")} focuses it`
          : "Type to filter, tap a command to run it"}
      </Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="highlighted">
              <Text style={{ fontSize: 13, color: ui().text }}>{highlighted() ?? "none"}</Text>
            </Panel>
            <Panel title="query">
              <Text style={{ fontSize: 13, color: ui().text }}>{query() ? `“${query()}”` : "empty"}</Text>
            </Panel>
            <Log title="events" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={{ width: wide() ? 380 : undefined, alignSelf: wide() ? "center" : "stretch" }}>
          <Command
            ref={(r) => (palette = r)}
            items={items()}
            query={query()}
            onQueryChange={({ query: next }) => query.set(next)}
            onHighlightChange={({ highlighted: next }) => highlighted.set(next)}
            onCancel={() => log("onCancel()")}
            onSelect={({ id }) => {
              if (id === "dark" || id === "light") appearance.set(id);
              log(`onSelect({ id: "${id}" })`);
            }}
            placeholder="Type a command or search…"
            accessibilityLabel="Commands"
            searchAccessibilityLabel="Search commands"
            class={commandClasses.root}
            searchBarClass={commandClasses.searchBar}
            searchClass={commandClasses.search}
            listClass={commandClasses.list}
            groupClass={commandClasses.group}
            separatorClass={commandClasses.separator}
            itemClass={commandClasses.item}
            style={{ height: desktop ? 360 : 400 }}
            searchPrefix={<Icon name="search" size={16} tint={ui().muted} />}
            empty={<CommandEmpty label="No commands match" />}
            renderGroup={(group) => <CommandHeading group={group} />}
            renderItem={(entry) => <CommandRow entry={entry} icon={icons[entry.id]} note={entry.disabled ? "Pro" : undefined} />}
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
