import { keymap, platform, signal, Text, View } from "nsh";
import { Button, Command, type CommandItem, type CommandRef, Dialog } from "nsh/base";
import type { IconName } from "../icons";
import {
  backdrop,
  Caption,
  Card,
  colors,
  CommandEmpty,
  CommandHeading,
  CommandRow,
  commandClasses,
  DemoPage,
  desktop,
  Icon,
  mono,
  Spinner,
  TERMINAL_GAP,
  terminal,
  Toggle as Switch,
} from "../ui";

// `nsh/base`'s `Command` owns the filtering (natively, by label and
// keywords), the sections, the highlight, the keyboard and what screen
// readers hear; its rows are virtualized, so 5 000 files filter at every
// keystroke. Every part here is the gallery's: `commandClasses` for the
// frame, the search bar and the rows' states, `CommandRow` for an icon,
// the label and the shortcut's keys.

/** A command of the mail app's palette, with its icon. */
interface Action {
  item: CommandItem;
  icon: IconName;
}

const ACTIONS: Action[] = [
  { item: { id: "go:inbox", label: "Go to Inbox", group: "Go to", shortcut: "mod+1", keywords: ["mail"] }, icon: "mail" },
  { item: { id: "go:drafts", label: "Go to Drafts", group: "Go to", shortcut: "mod+2" }, icon: "document" },
  { item: { id: "go:archive", label: "Go to Archive", group: "Go to", shortcut: "mod+3" }, icon: "storage" },
  { item: { id: "go:settings", label: "Open Settings", group: "Go to", shortcut: "mod+,", keywords: ["preferences"] }, icon: "controls" },
  { item: { id: "new", label: "New Message", group: "Actions", shortcut: "mod+n", keywords: ["compose", "write"] }, icon: "plus" },
  { item: { id: "reply", label: "Reply All", group: "Actions", shortcut: "mod+shift+r" }, icon: "back" },
  { item: { id: "archive", label: "Archive Conversation", group: "Actions", shortcut: "mod+e" }, icon: "storage" },
  { item: { id: "star", label: "Star Conversation", group: "Actions", shortcut: "mod+shift+l", keywords: ["flag", "favorite"] }, icon: "star" },
  { item: { id: "export", label: "Export Mailbox", group: "Actions", disabled: true }, icon: "download" },
  { item: { id: "theme:dark", label: "Dark Appearance", group: "Appearance", keywords: ["theme", "night"] }, icon: "moon" },
  { item: { id: "theme:light", label: "Light Appearance", group: "Appearance", keywords: ["theme", "day"] }, icon: "sun" },
  { item: { id: "help:keys", label: "Keyboard Shortcuts", group: "Help", shortcut: "mod+/" }, icon: "code" },
  { item: { id: "help:feedback", label: "Send Feedback", group: "Help" }, icon: "chat" },
];
const actionOf = (id: string) => ACTIONS.find((a) => a.item.id === id || `recent:${a.item.id}` === id);

/** Folders a conversation moves to. */
const FOLDERS: { id: string; label: string; icon: IconName; detail: string }[] = [
  { id: "inbox", label: "Inbox", icon: "mail", detail: "128 conversations" },
  { id: "archive", label: "Archive", icon: "storage", detail: "4 210 conversations" },
  { id: "projects/nsh", label: "Projects / NSH", icon: "folder", detail: "312 conversations" },
  { id: "projects/site", label: "Projects / Website", icon: "folder", detail: "87 conversations" },
  { id: "receipts", label: "Receipts", icon: "document", detail: "640 conversations" },
  { id: "spam", label: "Spam", icon: "close", detail: "Moved by the server only" },
];

/** 5 000 files in 50 folders, found by name or by extension. */
const EXTENSIONS = ["rs", "tsx", "md", "json", "png"] as const;
const ICONS: Record<(typeof EXTENSIONS)[number], IconName> = { rs: "code", tsx: "code", md: "document", json: "document", png: "image" };
const FILES: CommandItem[] = Array.from({ length: 5000 }, (_, i) => {
  const ext = EXTENSIONS[i % EXTENSIONS.length];
  const folder = `module-${String(Math.floor(i / 100) + 1).padStart(2, "0")}`;
  return { id: `f${i}`, label: `${folder}/file-${i + 1}.${ext}`, group: folder, keywords: [ext] };
});

/** The people a server answers for. */
const PEOPLE = [
  "Ada Lovelace", "Alan Turing", "Barbara Liskov", "Bjarne Stroustrup", "Claude Shannon", "Dennis Ritchie",
  "Donald Knuth", "Edsger Dijkstra", "Frances Allen", "Grace Hopper", "Guido van Rossum", "Hedy Lamarr",
  "John McCarthy", "Ken Thompson", "Katherine Johnson", "Leslie Lamport", "Linus Torvalds", "Margaret Hamilton",
  "Niklaus Wirth", "Radia Perlman", "Rob Pike", "Shafi Goldwasser", "Sophie Wilson", "Tim Berners-Lee",
];
/** 5000 as "5 000". */
const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

const roleOf = (i: number) => ["Engineering", "Research", "Design", "Operations"][i % 4];

export function CommandDemo() {
  const last = signal("—");

  function Palette() {
    const open = signal(false);
    const recent = signal<string[]>(["new", "go:inbox"]);
    const highlighted = signal<string | null>(null);
    // Each opening starts from an empty query.
    const query = signal("");
    const show = (next: boolean) => {
      if (next) query.set("");
      open.set(next);
    };
    // Bound while the demo shows; the gallery's own Cmd+K (its search)
    // comes back when it goes.
    keymap.bind("mod+k", () => show(!open()));
    const items = () => [
      ...recent().map((id) => ({ ...actionOf(id)!.item, id: `recent:${id}`, group: "Recent" })),
      ...ACTIONS.map((a) => a.item),
    ];
    const run = (id: string) => {
      const action = actionOf(id)!;
      const plain = action.item.id;
      recent.set([plain, ...recent().filter((r) => r !== plain)].slice(0, 3));
      open.set(false);
      last.set(`Ran ${action.item.label}`);
    };
    return (
      <Card
        title="Command palette"
        subtitle={desktop() ? `${keymap.label("mod+k")} opens it in a dialog: recent commands, sections, shortcuts, a disabled one` : "A dialog of commands: recent ones first, sections, a disabled one"}
      >
        <Button
          onPress={() => show(true)}
          class="flex-row items-center gap-2 rounded-lg border border-border bg-raised px-3 transition-colors motion-reduce:transition-none hover:bg-hover active:opacity-70 focus:outline-2 focus:outline-ring"
          style={{ height: desktop() ? 36 : 44 }}
        >
          <Icon name="search" size={16} tint={colors.muted} />
          <Text style={{ flex: 1, fontSize: 14, color: colors.muted }}>Search commands…</Text>
          {desktop() ? (
            <View class="rounded border border-border px-1.5" style={{ height: 20, justifyContent: "center" }}>
              <Text style={{ fontSize: 11, color: colors.muted }}>{keymap.label("mod+k")}</Text>
            </View>
          ) : null}
        </Button>
        <Caption label={`Recent: ${recent().map((id) => actionOf(id)!.item.label).join(", ")}`} />
        <Dialog
          open={open()}
          animation="fade"
          onOpenChange={({ open: next }) => show(next)}
          backdropStyle={backdrop()}
          style={
            desktop()
              ? { marginHorizontal: "auto", marginTop: "12%", width: 560, maxWidth: "92%" }
              : { marginHorizontal: 12, marginTop: "calc(env(safe-area-inset-top) + 12px)" }
          }
        >
          <Command
            items={items()}
            query={query()}
            onQueryChange={({ query: next }) => query.set(next)}
            // Escape with an empty query: the palette closes.
            onCancel={() => show(false)}
            autoFocus
            placeholder="Type a command or search…"
            accessibilityLabel="Commands"
            searchAccessibilityLabel="Search commands"
            onSelect={({ id }) => run(id)}
            onHighlightChange={({ highlighted: next }) => highlighted.set(next)}
            class={commandClasses.root}
            searchBarClass={commandClasses.searchBar}
            searchClass={commandClasses.search}
            listClass={`${commandClasses.list} ${desktop() ? "max-h-96" : "max-h-80"}`}
            groupClass={commandClasses.group}
            separatorClass={commandClasses.separator}
            itemClass={commandClasses.item}
            searchPrefix={<Icon name="search" size={16} tint={colors.muted} />}
            empty={<CommandEmpty label="No commands match" />}
            renderGroup={(group) => <CommandHeading group={group} />}
            renderItem={(entry) => <CommandRow entry={entry} icon={actionOf(entry.id)?.icon} note={entry.disabled ? "Admin" : undefined} />}
            footer={
              desktop() ? (
                <View class="flex-row gap-4 border-t border-border px-3" style={{ height: 32, alignItems: "center", ...(terminal ? { gap: TERMINAL_GAP } : {}) }}>
                  <Text style={{ fontSize: 11, color: colors.faint }}>↑↓ to move</Text>
                  <Text style={{ fontSize: 11, color: colors.faint }}>↩ to run</Text>
                  <Text style={{ fontSize: 11, color: colors.faint }}>esc to close</Text>
                  <Text style={{ flex: 1, textAlign: "right", fontSize: 11, color: colors.faint, numberOfLines: 1 }}>
                    {highlighted() ? actionOf(highlighted()!)?.item.label ?? "" : ""}
                  </Text>
                </View>
              ) : undefined
            }
          />
        </Dialog>
      </Card>
    );
  }

  function MoveTo() {
    const folder = signal("projects/nsh");
    const searchable = signal(true);
    return (
      <Card
        title="Move to"
        subtitle="An inline menu: the folder in effect is checked, Spam is the server's"
        right={
          // The terminal's switch is a glyph: its label beside it says what it turns on.
          platform.idiom === "terminal" ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Text style={{ fontSize: 12, color: colors.muted }}>Search</Text>
              <Switch value={searchable()} onChange={(v) => searchable.set(v)} label="Search" />
            </View>
          ) : (
            <Switch value={searchable()} onChange={(v) => searchable.set(v)} label="Search" />
          )
        }
      >
        <Command
          items={FOLDERS.map((f) => ({ id: f.id, label: f.label, checked: f.id === folder(), disabled: f.id === "spam" }))}
          searchable={searchable()}
          placeholder="Move to folder…"
          accessibilityLabel="Folders"
          searchAccessibilityLabel="Search folders"
          onSelect={({ id }) => {
            folder.set(id);
            last.set(`Moved to ${FOLDERS.find((f) => f.id === id)!.label}`);
          }}
          class={commandClasses.root}
          searchBarClass={commandClasses.searchBar}
          searchClass={commandClasses.search}
          listClass={commandClasses.list}
          itemClass={commandClasses.item}
          searchPrefix={<Icon name="folder" size={16} tint={colors.muted} />}
          empty={<CommandEmpty label="No folder matches" />}
          renderItem={(entry) => {
            const f = FOLDERS.find((x) => x.id === entry.id)!;
            return <CommandRow entry={entry} icon={f.icon} detail={f.detail} />;
          }}
        />
        <Caption
          label={`In ${FOLDERS.find((f) => f.id === folder())!.label}`}
          note={searchable() ? "Type to filter" : desktop() ? "Tab in: arrows, letters, Space" : "Tap a folder"}
        />
      </Card>
    );
  }

  function Files() {
    const count = signal(FILES.length);
    let palette: CommandRef | undefined;
    return (
      <Card title="5 000 files" subtitle="Filtered natively at every keystroke; only the rows in view are made. Try “rs” or “42”">
        <Command
          ref={(r) => (palette = r)}
          items={FILES}
          placeholder="Search files by name or extension…"
          accessibilityLabel="Files"
          searchAccessibilityLabel="Search files"
          // The ref's methods answer once the query is applied.
          onQueryChange={async () => count.set((await palette?.matchedCount()) ?? 0)}
          onSelect={({ id }) => last.set(`Opened ${FILES[Number(id.slice(1))].label}`)}
          class={commandClasses.root}
          searchBarClass={commandClasses.searchBar}
          searchClass={commandClasses.search}
          listClass={`${commandClasses.list} h-72`}
          groupClass={commandClasses.group}
          separatorClass={commandClasses.separator}
          itemClass={commandClasses.item}
          searchPrefix={<Icon name="search" size={16} tint={colors.muted} />}
          empty={<CommandEmpty label="No file matches" />}
          renderGroup={(group) => <CommandHeading group={group} />}
          renderItem={(entry) => <CommandRow entry={entry} icon={ICONS[entry.keywords[0] as (typeof EXTENSIONS)[number]]} />}
        />
        <Caption label={`${grouped(count())} of ${grouped(FILES.length)} files`} note="50 folders" />
      </Card>
    );
  }

  function Directory() {
    const results = signal<CommandItem[]>([]);
    const loading = signal(false);
    const query = signal("");
    let asked = 0;
    const search = (q: string) => {
      query.set(q);
      const ask = ++asked;
      if (!q.trim()) {
        loading.set(false);
        results.set([]);
        return;
      }
      loading.set(true);
      // A server's answer, a moment later; an older answer is dropped.
      setTimeout(() => {
        if (ask !== asked) return;
        const needle = q.trim().toLowerCase();
        results.set(
          PEOPLE.map((name, i) => ({ name, i }))
            .filter(({ name }) => name.toLowerCase().includes(needle))
            // The server ranks the names that start with the query first.
            .sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)))
            .map(({ name, i }) => ({ id: `p${i}`, label: name, keywords: [roleOf(i)] })),
        );
        loading.set(false);
      }, 450);
    };
    return (
      <Card title="Directory search" subtitle="The server answers: filterable={false}, loading while it does, its ranking kept">
        <Command
          items={results()}
          filterable={false}
          loading={loading()}
          query={query()}
          onQueryChange={({ query: next }) => search(next)}
          placeholder="Search people…"
          accessibilityLabel="People"
          searchAccessibilityLabel="Search people"
          onSelect={({ id }) => last.set(`Messaged ${PEOPLE[Number(id.slice(1))]}`)}
          class={commandClasses.root}
          searchBarClass={commandClasses.searchBar}
          searchClass={commandClasses.search}
          listClass={`${commandClasses.list} max-h-64`}
          itemClass={commandClasses.item}
          searchPrefix={<Icon name="search" size={16} tint={colors.muted} />}
          searchSuffix={loading() ? <Spinner size={14} tint={colors.muted} /> : undefined}
          empty={<CommandEmpty label={query().trim() ? `No one matches “${query().trim()}”` : "Type a name to search the directory"} />}
          renderItem={(entry) => <CommandRow entry={entry} icon="mail" detail={entry.keywords[0]} />}
        />
        <Caption label={loading() ? "Searching…" : `${results().length} found`} note="450 ms latency" />
      </Card>
    );
  }

  function Last() {
    return (
      <Card title="Last event">
        <Text style={{ fontSize: 13, color: colors.text, fontFamily: mono }}>{last()}</Text>
      </Card>
    );
  }

  return <DemoPage cards={[Palette, MoveTo, Files, Directory, Last]} />;
}
