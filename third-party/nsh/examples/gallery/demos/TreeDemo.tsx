import { type JSX, platform, signal, Text, View } from "nsh";
import { Tree, type TreeItem, type TreeRef } from "nsh/base";
import type { IconName } from "../icons";
import { Button as GalleryButton, Caption, Card, colors, DemoPage, desktop, terminal, TreeRow, treeItemClass, treeRowHeight, LastEvent, LabeledToggle } from "../ui";

// `nsh/base`'s `Tree` owns which items are expanded, which one is selected,
// the keyboard (one Tab stop: the arrows move the selection, Right and Left
// open and close) and what screen readers hear; its rows are virtualized,
// so a collapsed folder's children are never made. Every row here is the
// gallery's: `treeItemClass` for its states and `TreeRow` for its chevron,
// icon and label indented by depth.

const pointer = platform.idiom === "desktop";
/**
 * A tree's well: a quiet fill without a border of its own, so the card holds one box (stronger in dark, where the
 * muted fill is all but the card's color); in a terminal a box as wide as
 * the card's content, so its band keeps a column inside the card's line, as the card's other wells do, and its rows'
 * text a column inside the band.
 */
const well = terminal ? "rounded-xl border border-border bg-card w-full" : "rounded-lg bg-muted/40 dark:bg-muted/70";
const wellList = terminal ? "px-2" : "p-1.5";
/**
 * A well as tall as its first `rows` rows and the list's padding, so nothing is left blank below the last one; more
 * rows scroll. The terminal keeps its height of whole rows (`terminalHeight`).
 */
const tall = (rows: number, terminalHeight: number) => ({ height: terminal ? terminalHeight : rows * treeRowHeight + 12 });

/** A card's actions: in its header beside the title in a wide window, the
 * first row of its content otherwise, so a narrow card's subtitle keeps
 * its width. */
function Actions(props: { children: JSX.Element }) {
  return <View style={{ flexDirection: "row", gap: 6, alignSelf: desktop() ? undefined : "flex-start" }}>{props.children}</View>;
}

/** A small secondary button of the gallery's (`buttonLook`), in a card's header. */
function Action(props: { label: string; disabled?: boolean; onPress: () => void }) {
  return <GalleryButton label={props.label} variant="secondary" size="small" disabled={props.disabled} onPress={props.onPress} />;
}

const project: TreeItem[] = [
  {
    id: "app",
    label: "app",
    children: [
      {
        id: "app/src",
        label: "src",
        children: [
          { id: "app/src/main.rs", label: "main.rs" },
          { id: "app/src/router.rs", label: "router.rs" },
          {
            id: "app/src/views",
            label: "views",
            children: [
              { id: "app/src/views/inbox.rs", label: "inbox.rs" },
              { id: "app/src/views/thread.rs", label: "thread.rs" },
              { id: "app/src/views/compose.rs", label: "compose.rs" },
            ],
          },
        ],
      },
      {
        id: "app/assets",
        label: "assets",
        children: [
          { id: "app/assets/logo.svg", label: "logo.svg" },
          { id: "app/assets/inter.ttf", label: "inter.ttf" },
        ],
      },
      { id: "app/Cargo.toml", label: "Cargo.toml" },
    ],
  },
  { id: "target", label: "target", disabled: true, children: [{ id: "target/release", label: "release" }] },
  { id: "nsh.json", label: "nsh.json" },
  { id: "README.md", label: "README.md" },
];

const sizes: Record<string, string> = {
  "app/src/main.rs": "1.4 KB",
  "app/src/router.rs": "3.8 KB",
  "app/src/views/inbox.rs": "12 KB",
  "app/src/views/thread.rs": "9.6 KB",
  "app/src/views/compose.rs": "7.1 KB",
  "app/assets/logo.svg": "2.2 KB",
  "app/assets/inter.ttf": "310 KB",
  "app/Cargo.toml": "740 B",
  "nsh.json": "512 B",
  "README.md": "3.0 KB",
};

/** Settings, each section with an icon and its words. */
const settings: { item: TreeItem; icon: IconName; text: string }[] = [
  { item: { id: "general", label: "General" }, icon: "controls", text: "Language, region and what opens at launch." },
  { item: { id: "appearance", label: "Appearance" }, icon: "sun", text: "Light, dark, or as the system is; the accent color." },
  { item: { id: "notifications", label: "Notifications" }, icon: "bell", text: "Which accounts alert you, and how quietly." },
  { item: { id: "privacy", label: "Privacy" }, icon: "lock", text: "Read receipts, tracking protection and remote content." },
  { item: { id: "privacy/blocked", label: "Blocked senders" }, icon: "close", text: "Mail from them goes straight to the trash." },
  { item: { id: "privacy/data", label: "Data and storage" }, icon: "storage", text: "What is kept on this device, and for how long." },
  { item: { id: "accounts", label: "Accounts" }, icon: "mail", text: "Your mailboxes, their signatures and aliases." },
  { item: { id: "accounts/work", label: "Work" }, icon: "mail", text: "work@example.com, synced every minute." },
  { item: { id: "accounts/home", label: "Home" }, icon: "mail", text: "me@example.com, synced as mail arrives." },
  { item: { id: "billing", label: "Billing", disabled: true }, icon: "stocks", text: "" },
];
const settingOf = (id: string) => settings.find((s) => s.item.id === id)!;
const child = (id: string) => settingOf(id).item;
const sidebar: TreeItem[] = [
  child("general"),
  child("appearance"),
  child("notifications"),
  { ...child("privacy"), children: [child("privacy/blocked"), child("privacy/data")] },
  { ...child("accounts"), children: [child("accounts/work"), child("accounts/home")] },
  child("billing"),
];

/** 100 folders of 100 files: 10 100 items. */
const large: TreeItem[] = Array.from({ length: 100 }, (_, f) => ({
  id: `f${f}`,
  label: `Folder ${String(f + 1).padStart(3, "0")}`,
  children: Array.from({ length: 100 }, (_, i) => ({ id: `f${f}/${i}`, label: `file-${f + 1}-${i + 1}.log` })),
}));

export function TreeDemo() {
  const last = signal("—");

  function Files() {
    const expanded = signal(["app", "app/src"]);
    const selected = signal<string | null>("app/src/router.rs");
    const opened = signal<string | null>(null);
    let tree: TreeRef | undefined;
    const actions = () => (
      <Actions>
        <Action label="Reveal compose.rs" onPress={() => tree?.revealItem("app/src/views/compose.rs")} />
        <Action label="Collapse all" disabled={expanded().length === 0} onPress={() => expanded.set([])} />
      </Actions>
    );
    return (
      <Card
        title="Files"
        subtitle={`${pointer ? "A double click" : "A double tap"} opens a file`}
        right={desktop() ? actions() : undefined}
      >
        {desktop() ? null : actions()}
        <Tree
          ref={(r) => (tree = r)}
          items={project}
          expanded={expanded()}
          selected={selected()}
          reveal
          accessibilityLabel="Project files"
          class={well}
          style={tall(pointer ? 10 : 8, 320)}
          listClass={wellList}
          itemClass={treeItemClass}
          onExpandedChange={({ expanded: next }) => expanded.set(next)}
          onSelectedChange={({ selected: next }) => {
            selected.set(next);
            last.set(`Selected ${next}`);
          }}
          onExpand={({ id }) => last.set(`Expanded ${id}`)}
          onCollapse={({ id }) => last.set(`Collapsed ${id}`)}
          // The arrows select row by row; a file opens only on the action
          // (a folder's action is its press, which already opened it).
          onAction={({ id }) => {
            if (!(id in sizes)) return;
            opened.set(id);
            last.set(`Opened ${id}`);
          }}
          renderItem={(entry) => <TreeRow entry={entry} detail={entry.disabled ? "excluded" : sizes[entry.id]} />}
        />
        <Caption
          label={`Selected: ${selected() ?? "none"}`}
          note={opened() ? `Open: ${opened()!.split("/").pop()}` : `${expanded().length} open`}
        />
      </Card>
    );
  }

  function Settings() {
    const section = signal("notifications");
    return (
      <Card title="Settings" subtitle="Sections in a sidebar; Privacy starts open">
        <View style={{ flexDirection: desktop() ? "row" : "column", gap: 12 }}>
          <Tree
            items={sidebar}
            defaultExpanded={["privacy"]}
            defaultSelected="notifications"
            accessibilityLabel="Settings"
            class={well}
            style={{ ...tall(8, desktop() ? 280 : 300), width: desktop() ? 210 : undefined }}
            listClass={wellList}
            itemClass={treeItemClass}
            onSelectedChange={({ selected: next }) => {
              section.set(next);
              last.set(`Section ${settingOf(next).item.label}`);
            }}
            renderItem={(entry) => {
              const s = settingOf(entry.id);
              return <TreeRow entry={entry} icon={s.icon} tint={entry.disabled ? colors.faint : colors.muted} detail={entry.disabled ? "Admin" : undefined} />;
            }}
          />
          <View style={{ flex: desktop() ? 1 : undefined, minWidth: 0, gap: 6, padding: 4 }}>
            <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text }}>{settingOf(section()).item.label}</Text>
            <Text style={{ fontSize: 13, color: colors.muted, lineHeight: 19 }}>{settingOf(section()).text}</Text>
          </View>
        </View>
      </Card>
    );
  }

  function Large() {
    const expanded = signal(["f0"]);
    const selected = signal<string | null>(null);
    let tree: TreeRef | undefined;
    const actions = () => (
      <Actions>
        <Action label="Reveal file-87-42" onPress={() => tree?.revealItem("f86/41")} />
      </Actions>
    );
    return (
      <Card
        title="10 100 items"
        subtitle="Only the rows in view are made"
        right={desktop() ? actions() : undefined}
      >
        {desktop() ? null : actions()}
        <Tree
          ref={(r) => (tree = r)}
          items={large}
          expanded={expanded()}
          selected={selected()}
          accessibilityLabel="Logs"
          class={well}
          style={tall(pointer ? 10 : 7, 288)}
          listClass={wellList}
          itemClass={treeItemClass}
          onExpandedChange={({ expanded: next }) => expanded.set(next)}
          onSelectedChange={({ selected: next }) => {
            selected.set(next);
            last.set(`Selected ${next}`);
          }}
          renderItem={(entry) => <TreeRow entry={entry} />}
        />
        <Caption label={`Selected: ${selected() ?? "none"}`} note={`${expanded().length} of 100 folders open`} />
      </Card>
    );
  }

  function ReadOnly() {
    const locked = signal(true);
    return (
      <Card
        title="Read-only"
        subtitle="An outline to read, not to change"
        right={<LabeledToggle label="Lock" value={locked()} onChange={(v) => locked.set(v)} />}
      >
        <Tree
          items={[
            {
              id: "q4",
              label: "Q4 plan",
              children: [
                { id: "q4/goals", label: "Goals" },
                { id: "q4/hiring", label: "Hiring", children: [{ id: "q4/hiring/eng", label: "Engineering" }] },
                { id: "q4/budget", label: "Budget" },
              ],
            },
          ]}
          defaultExpanded={["q4", "q4/hiring"]}
          defaultSelected="q4/goals"
          disabled={locked()}
          accessibilityLabel="Outline"
          class={well}
          style={tall(5, 160)}
          listClass={wellList}
          itemClass={treeItemClass}
          onSelectedChange={({ selected: next }) => last.set(`Outline ${next}`)}
          renderItem={(entry) => <TreeRow entry={entry} icon={entry.folder ? "lists" : "document"} />}
        />
        <Caption label={locked() ? "Locked: it shows its state and takes no input" : "Unlocked: press a row, or Tab in and use the arrows"} />
      </Card>
    );
  }

  function Last() {
    return (
      <Card title="Last event">
        <LastEvent value={last()} hint="Choose an item" />
      </Card>
    );
  }

  return <DemoPage cards={[Files, Settings, Large, ReadOnly, Last]} />;
}
