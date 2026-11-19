import { cleanup, type JSX, Overlay, platform, windowSize, Scroll, type ScrollRef, signal, Text, View } from "nsh";
import {
  Button,
  RichEditor,
  RichEditorPlugin,
  StarterKit,
  TableKit,
  chain,
  command,
  createRichEditor,
  defineExtension,
  deleteRange,
  insertContent,
  insertContentAt,
  liftListItem,
  setNode,
  setNodeAttribute,
  setNodeSelection,
  setTextSelection,
  sinkListItem,
  suggestion,
  wrapIn,
  type RichCommand,
  type RichEditorSession,
} from "nsh/base";
import { LucideIcon, type LucideIconName } from "../icons";
import { createLinkMenu, LinkBubble } from "./RichEditorLink";
import { alpha, colors, focusRing, hovered, PopIn, popupSurface, richEditorClasses } from "../ui";

// A block editor in the manner of Notion, built from `nsh/base`'s
// `RichEditor` and Tiptap's extensions. Everything around the document is
// the app's: type `/` for a menu of blocks (Tiptap's Suggestion, which the
// editor runs natively, so Enter and the arrows pick without waiting for JS),
// hover a block for its handle (`+` adds a block below, the grip drags it
// and, pressed without moving, opens the block's menu), and select text for
// a floating toolbar. All of them are commands on the session.

const DOC = `# Q4 launch plan

Type \`/\` anywhere for the blocks, or hover a block and use the handle in the margin.

## Goals

- Ship the new order ticket to every region
- Cut the time to first trade by a third
- Move the help center to the new editor

## This week

- [x] Review the pricing page copy
- [x] Freeze the design of the ticket
- [ ] Walk support through the new flow
- [ ] Publish the migration guide

> Good tools disappear: people should remember the work, not the editor.

## Rollout

1. Confirm the launch date
2. Brief the regional leads
3. Open the beta to five percent of traffic

## Numbers to watch

| Metric | Now | Goal |
| --- | --- | --- |
| Time to first trade | 9 min | 6 min |
| Orders per session | 1.8 | 2.4 |

Select some text for the toolbar: **bold**, *italic*, ~~strike~~ and \`code\` are a press away.
`;

// --- The blocks ------------------------------------------------------------

/** A block the `/` menu and a handle's menu turn text into. */
type Block = {
  id: string;
  /** The heading it stands under in the `/` menu. */
  group: "Style" | "Lists" | "Insert";
  title: string;
  hint: string;
  icon: LucideIconName;
  keywords: string;
  /** The command that makes it, or what to do with the editor when one command cannot say it. */
  apply: RichCommand | ((editor: RichEditorSession) => void);
  /** A list: it changes the list around the caret, others leave it first. */
  list?: boolean;
  /** The node the caret's block is while it is this block (`[type, attrs]`), for the toolbar's pressed state. */
  node?: [string, Record<string, unknown>?];
};

const BLOCKS: Block[] = [
  { id: "text", group: "Style", node: ["paragraph"], title: "Text", hint: "Plain text, the start of everything", icon: "pilcrow", keywords: "paragraph plain", apply: command("setParagraph") },
  { id: "h1", group: "Style", node: ["heading", { level: 1 }], title: "Heading 1", hint: "A big section heading", icon: "heading-1", keywords: "title h1 header", apply: setNode("heading", { level: 1 }) },
  { id: "h2", group: "Style", node: ["heading", { level: 2 }], title: "Heading 2", hint: "A medium heading", icon: "heading-2", keywords: "subtitle h2 header", apply: setNode("heading", { level: 2 }) },
  { id: "h3", group: "Style", node: ["heading", { level: 3 }], title: "Heading 3", hint: "A small heading", icon: "heading-3", keywords: "h3 header", apply: setNode("heading", { level: 3 }) },
  { id: "quote", group: "Style", node: ["blockquote"], title: "Quote", hint: "Set a thought apart", icon: "text-quote", keywords: "blockquote citation", apply: command("toggleBlockquote") },
  { id: "bullet", group: "Lists", node: ["bulletList"], list: true, title: "Bulleted list", hint: "A simple list of points", icon: "list", keywords: "ul unordered bullets", apply: command("toggleBulletList") },
  { id: "numbered", group: "Lists", node: ["orderedList"], list: true, title: "Numbered list", hint: "A list that counts", icon: "list-ordered", keywords: "ol ordered steps", apply: command("toggleOrderedList") },
  { id: "todo", group: "Lists", node: ["taskList"], list: true, title: "To-do list", hint: "Track tasks with checkboxes", icon: "list-todo", keywords: "task checkbox", apply: command("toggleTaskList") },
  { id: "code", group: "Insert", node: ["codeBlock"], title: "Code", hint: "Code with its own font", icon: "square-code", keywords: "snippet pre", apply: command("toggleCodeBlock") },
  { id: "divider", group: "Insert", title: "Divider", hint: "A line between sections", icon: "minus", keywords: "rule hr separator", // The caret goes on in a new line below the rule, as in Notion.
    apply: chain([command("setHorizontalRule"), command("createParagraphNear")]),
  },
  { id: "callout", group: "Insert", node: ["callout"], title: "Callout", hint: "Make writing stand out", icon: "info", keywords: "note tip aside highlight box", apply: wrapIn("callout") },
  {
    id: "columns", group: "Insert", title: "2 columns", hint: "Blocks side by side", icon: "panel-left", keywords: "column layout split side",
    // Two columns of a paragraph each. The caret is left in the last one: it goes to the first, three
    // positions into the row (the row's, the column's and the paragraph's starts).
    apply: (editor) => {
      editor.run(insertContent({ type: "columns", content: [{ type: "column", content: [{ type: "paragraph" }] }, { type: "column", content: [{ type: "paragraph" }] }] }));
      const head = editor.selection.head;
      const row = head == null ? undefined : blocksAround(editor, head).find((b) => b.type === "columns");
      if (row) editor.run(setTextSelection(row.start + 3));
    },
  },
  {
    id: "toggle", group: "Insert", title: "Toggle", hint: "Hide and show what is inside", icon: "chevron-right", keywords: "collapse fold details expand",
    // A title and a body of one paragraph, the caret in the title (past the toggle's and the title's starts).
    apply: (editor) => {
      editor.run(insertContent({ type: "toggle", content: [{ type: "toggleTitle" }, { type: "toggleBody", content: [{ type: "paragraph" }] }] }));
      const head = editor.selection.head;
      const toggle = head == null ? undefined : blocksAround(editor, head).find((b) => b.type === "toggle");
      if (toggle) editor.run(setTextSelection(toggle.start + 2));
    },
  },
  { id: "table", group: "Insert", title: "Table", hint: "Rows and columns", icon: "table", keywords: "grid", apply: command("insertTable", { rows: 3, cols: 3, withHeaderRow: true }) },
];

const BLOCK_TITLES = new Map(BLOCKS.map((b) => [b.id, b]));
/** The blocks of the floating toolbar (the others are in the `/` menu). */
const BAR_BLOCKS = ["h1", "h2", "h3", "bullet", "todo"].map((id) => BLOCK_TITLES.get(id)!);

const MARKS: { icon: LucideIconName; label: string; name: string; toggle: string }[] = [
  { icon: "bold", label: "Bold", name: "bold", toggle: "toggleBold" },
  { icon: "italic", label: "Italic", name: "italic", toggle: "toggleItalic" },
  { icon: "underline", label: "Underline", name: "underline", toggle: "toggleUnderline" },
  { icon: "strikethrough", label: "Strikethrough", name: "strike", toggle: "toggleStrike" },
  { icon: "code", label: "Code", name: "code", toggle: "toggleCode" },
  { icon: "palette", label: "Highlight", name: "highlight", toggle: "toggleHighlight" },
];

/** A callout: blocks set apart in a tinted box, as Notion's. The app's own node type, declared as Tiptap's `Node.create`. */
const callout = defineExtension({
  name: "callout",
  node: {
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "div[data-callout]" }],
    toDOM: ["div", { "data-callout": "" }, 0],
  },
});

/** Columns: blocks side by side, as Notion's. A row (`columns`) of two or more `column`s, each holding blocks. */
const columns = defineExtension({
  name: "columns",
  node: { content: "column column+", group: "block", defining: true, isolating: true, parseDOM: [{ tag: "div[data-columns]" }], toDOM: ["div", { "data-columns": "" }, 0] },
});
const column = defineExtension({
  name: "column",
  node: { content: "block+", defining: true, isolating: true, parseDOM: [{ tag: "div[data-column]" }], toDOM: ["div", { "data-column": "" }, 0] },
});

/** The colors text takes (the `textStyle` mark's `color`), each a class of the theme's or Tailwind's palette. */
const TEXT_COLORS: { name: string; label: string; class: string }[] = [
  { name: "gray", label: "Gray", class: "text-muted-foreground" },
  { name: "red", label: "Red", class: "text-down" },
  { name: "orange", label: "Orange", class: "text-amber-500" },
  { name: "green", label: "Green", class: "text-up" },
  { name: "blue", label: "Blue", class: "text-sky-500" },
  { name: "purple", label: "Purple", class: "text-violet-500" },
];

/**
 * A toggle, as Notion's: a title and a body that hides. The body carries `open` (a class per value hides it); the
 * arrow that turns it is the app's, in the editor's layer over the document.
 */
const toggle = defineExtension({
  name: "toggle",
  node: { content: "toggleTitle toggleBody", group: "block", defining: true, parseDOM: [{ tag: "div[data-toggle]" }], toDOM: ["div", { "data-toggle": "" }, 0] },
});
const toggleTitle = defineExtension({
  name: "toggleTitle",
  node: { content: "inline*", defining: true, parseDOM: [{ tag: "div[data-toggle-title]" }], toDOM: ["div", { "data-toggle-title": "" }, 0] },
});
const toggleBody = defineExtension({
  name: "toggleBody",
  node: {
    content: "block+",
    defining: true,
    attrs: { open: { default: true } },
    parseDOM: [{ tag: "div[data-toggle-body]" }],
    toDOM: ["div", { "data-toggle-body": "" }, 0],
  },
});

/** `/` opens the blocks: Tiptap's Suggestion with its own keys. It ranks above the keymap, so Enter picks before it splits a paragraph. */
const slash = defineExtension({
  name: "slashCommand",
  priority: 1000,
  addProseMirrorPlugins: () => [
    suggestion({ key: "slash", char: "/", captureKeys: ["ArrowUp", "ArrowDown", "Enter", "Tab"], decorationClass: "text-muted-foreground" }),
  ],
});

// --- Positions ---------------------------------------------------------------

type Resolved = { depth: number; start: number; end: number; parent: string };
type Rect = { x: number; y: number; width: number; height: number };

/** Blocks that are items of a list: each has a handle of its own, as in Notion. */
const ITEMS = new Set(["listItem", "taskItem"]);
/** Blocks without an inside. */
const LEAVES = new Set(["horizontalRule", "image"]);

/** The blocks around `pos`, the innermost first: their type and where each starts. */
function blocksAround(editor: RichEditorSession, pos: number): { type: string; start: number }[] {
  let at = editor.resolve(pos) as Resolved;
  // Between blocks (a divider has no inside): the block after it.
  if (at.depth === 0) {
    const node = editor.nodeAt(pos);
    return node ? [{ type: node.type ?? "", start: pos }] : [];
  }
  const around: { type: string; start: number }[] = [];
  while (at.depth > 0) {
    around.push({ type: at.parent, start: at.start - 1 });
    at = editor.resolve(at.start - 1) as Resolved;
  }
  return around;
}

/** The block a handle belongs to at `pos`: the item of a list when it is in one, else the top-level block; and the top-level block, whose margin the handle stands in. */
function handleTarget(editor: RichEditorSession, pos: number): { start: number; top: number } | null {
  const around = blocksAround(editor, pos);
  const top = around[around.length - 1];
  if (!top) return null;
  return { start: (around.find((b) => ITEMS.has(b.type)) ?? top).start, top: top.start };
}

/** Where the block starting at `start` ends. */
function blockEnd(editor: RichEditorSession, start: number): number {
  const node = editor.nodeAt(start);
  if (!node || LEAVES.has(node.type ?? "")) return start + 1;
  return (editor.resolve(start + 1) as Resolved).end + 1;
}

type DocNode = { type?: string; text?: string | null; content?: DocNode[] | null };

/** The block starting at `start` among its siblings: where the one before it starts and how long the one after it is (`null` at an end). */
function neighbors(editor: RichEditorSession, start: number): { before: number | null; after: number | null; size: number } | null {
  const node = editor.nodeAt(start) as DocNode | null;
  if (!node) return null;
  const at = editor.resolve(start) as Resolved & { index: number };
  // The siblings before it, from the parent's start.
  let pos = at.start;
  let before: number | null = null;
  for (let i = 0; i < at.index; i++) {
    const sibling = editor.nodeAt(pos) as DocNode | null;
    if (!sibling) return null;
    before = pos;
    pos += nodeSize(sibling);
  }
  const size = nodeSize(node);
  const next = start + size < at.end ? (editor.nodeAt(start + size) as DocNode | null) : null;
  return { before, after: next ? nodeSize(next) : null, size };
}

/** How many positions a node takes: its text's length, one for a leaf, else its content between its two ends. */
function nodeSize(node: DocNode): number {
  if (node.text != null) return node.text.length;
  if (LEAVES.has(node.type ?? "") || node.type === "hardBreak") return 1;
  return 2 + (node.content ?? []).reduce((sum, child) => sum + nodeSize(child), 0);
}

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);

/** Where each run of text with mark `mark` starts and ends in the document. */
function markRuns(doc: DocNode, mark: string): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  const walk = (node: DocNode & { marks?: { type?: string }[] | null }, pos: number) => {
    if (node.text != null) {
      if (node.marks?.some((m) => m.type === mark)) {
        const last = runs[runs.length - 1];
        // Text split by another mark (bold inside code) is one run.
        if (last && last.to === pos) last.to = pos + node.text.length;
        else runs.push({ from: pos, to: pos + node.text.length });
      }
      return;
    }
    let at = pos + 1;
    for (const child of node.content ?? []) {
      walk(child, at);
      at += nodeSize(child);
    }
  };
  // The document's own start is before position 0.
  walk(doc, -1);
  return runs;
}

/**
 * Two lists of one kind that came to stand next to each other (a block turned into a list beside one, an item
 * dropped between lists) become one, as in Notion, where items in a row are one list: the numbers run on and
 * the items are spaced alike.
 */
function joinLists(editor: RichEditorSession) {
  for (let pass = 0; pass < 8; pass++) {
    const blocks = ((editor.doc as DocNode).content ?? []) as DocNode[];
    let pos = 0;
    let joined = false;
    for (let i = 0; i < blocks.length - 1; i++) {
      pos += nodeSize(blocks[i]);
      if (LISTS.has(blocks[i].type ?? "") && blocks[i].type === blocks[i + 1].type) {
        // The first list's end and the second's start go: what is left is one list.
        joined = editor.run(deleteRange({ from: pos - 1, to: pos + 1 }));
        break;
      }
    }
    if (!joined) return;
  }
}

/** The text of a block, for the preview that follows the pointer while it is dragged. */
function plainText(node: { text?: string | null; content?: unknown[] | null }): string {
  if (node.text) return node.text;
  return (node.content ?? []).map((child) => plainText(child as { text?: string; content?: unknown[] })).join(" ");
}

// --- The parts ---------------------------------------------------------------

/** What every control answers: a fill under the pointer, a deeper one while pressed, and a ring where the keyboard is. */
const feedback = () => ({
  hoverStyle: hovered(),
  activeStyle: { backgroundColor: alpha(colors.text, 0.1) },
  focusVisibleStyle: focusRing(1),
});


const pointer = platform.desktop;

/** A block's icon on a small tile, as Notion's menu has them. */
function Tile(props: { icon: LucideIconName }) {
  return (
    <View style={{ width: 36, height: 36, borderRadius: 8, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
      <LucideIcon name={props.icon} size={18} tint={colors.text} />
    </View>
  );
}

/** The `/` menu's list: how tall it shows, and the height of a row and of a group's heading, for keeping the highlighted block in view. */
const MENU_HEIGHT = 340;
const MENU_WIDTH = 300;
const PREVIEW_WIDTH = 200;
const ROW = 48;
const HEADING = 28;

/** Whether item `i` starts a group: its heading stands over it. */
const startsGroup = (items: Block[], i: number) => i === 0 || items[i - 1].group !== items[i].group;

/** Where row `i` starts in the list, the headings over it counted. */
function rowTop(items: Block[], i: number): number {
  let top = 0;
  for (let k = 0; k <= i; k++) if (startsGroup(items, k)) top += HEADING;
  return top + i * ROW;
}

/** A line of text in a preview: a bar of the text's color. */
function Bar(props: { width: number; height?: number; strong?: boolean }) {
  return <View style={{ width: props.width, height: props.height ?? 6, borderRadius: 3, backgroundColor: alpha(colors.text, props.strong ? 0.55 : 0.18) }} />;
}

/** What a block looks like, small: the picture beside the menu's highlighted row, as Notion shows one. */
function Sample(props: { id: string }) {
  const row = (lead: JSX.Element, width: number) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {lead}
      <Bar width={width} />
    </View>
  );
  const dot = () => <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: alpha(colors.text, 0.55) }} />;
  const number = (n: number) => <Text style={{ width: 10, fontSize: 10, fontWeight: "600", color: colors.muted }}>{`${n}.`}</Text>;
  const box = (on: boolean) => (
    <View style={{ width: 10, height: 10, borderRadius: 3, borderWidth: 1, borderColor: on ? colors.accent : alpha(colors.text, 0.35), backgroundColor: on ? colors.accent : undefined }} />
  );
  switch (props.id) {
    case "h1":
    case "h2":
    case "h3": {
      const size = { h1: 12, h2: 10, h3: 8 }[props.id];
      return (
        <View style={{ gap: 8 }}>
          <Bar width={110} height={size} strong />
          <Bar width={150} />
          <Bar width={120} />
        </View>
      );
    }
    case "bullet":
      return <View style={{ gap: 8 }}>{row(dot(), 120)}{row(dot(), 96)}{row(dot(), 132)}</View>;
    case "numbered":
      return <View style={{ gap: 8 }}>{row(number(1), 120)}{row(number(2), 96)}{row(number(3), 132)}</View>;
    case "todo":
      return <View style={{ gap: 8 }}>{row(box(true), 120)}{row(box(true), 96)}{row(box(false), 132)}</View>;
    case "quote":
      return (
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ width: 3, borderRadius: 2, backgroundColor: alpha(colors.text, 0.35) }} />
          <View style={{ gap: 8, paddingVertical: 2 }}>
            <Bar width={140} />
            <Bar width={104} />
          </View>
        </View>
      );
    case "code":
      return (
        <View style={{ gap: 7, padding: 10, borderRadius: 6, backgroundColor: alpha(colors.text, 0.06) }}>
          <Bar width={96} strong />
          <View style={{ paddingLeft: 12, gap: 7 }}>
            <Bar width={120} />
            <Bar width={72} />
          </View>
          <Bar width={20} strong />
        </View>
      );
    case "callout":
      return (
        <View style={{ flexDirection: "row", gap: 10, padding: 10, borderRadius: 6, backgroundColor: alpha(colors.accent, 0.16) }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent }} />
          <View style={{ gap: 7, paddingTop: 2 }}>
            <Bar width={120} />
            <Bar width={84} />
          </View>
        </View>
      );
    case "columns":
      return (
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1, gap: 8 }}>
            <Bar width={70} />
            <Bar width={56} />
            <Bar width={64} />
          </View>
          <View style={{ flex: 1, gap: 8 }}>
            <Bar width={64} />
            <Bar width={72} />
            <Bar width={40} />
          </View>
        </View>
      );
    case "toggle":
      return (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <LucideIcon name="chevron-right" size={12} tint={colors.muted} />
            <Bar width={110} strong />
          </View>
          <View style={{ paddingLeft: 20, gap: 8 }}>
            <Bar width={130} />
            <Bar width={96} />
          </View>
        </View>
      );
    case "divider":
      return (
        <View style={{ gap: 10 }}>
          <Bar width={140} />
          <View style={{ height: 1, backgroundColor: alpha(colors.text, 0.35) }} />
          <Bar width={112} />
        </View>
      );
    case "table":
      return (
        <View style={{ borderWidth: 1, borderColor: alpha(colors.text, 0.25), borderRadius: 4, overflow: "hidden" }}>
          <Each of={[0, 1, 2]}>
            {(r) => (
              <View style={{ flexDirection: "row", borderTopWidth: r() ? 1 : 0, borderColor: alpha(colors.text, 0.25), backgroundColor: r() ? undefined : alpha(colors.text, 0.06) }}>
                <Each of={[0, 1, 2]}>
                  {(c) => (
                    <View style={{ flex: 1, padding: 6, borderLeftWidth: c() ? 1 : 0, borderColor: alpha(colors.text, 0.25) }}>
                      <Bar width={28} strong={!r()} />
                    </View>
                  )}
                </Each>
              </View>
            )}
          </Each>
        </View>
      );
    default:
      return (
        <View style={{ gap: 8 }}>
          <Bar width={150} />
          <Bar width={132} />
          <Bar width={90} />
        </View>
      );
  }
}

/** The `/` menu: the blocks matching what was typed under their groups' headings, the highlighted one picked by Enter and pictured beside the list. */
function SlashMenu(props: { shift: number; items: Block[]; index: number; onPick: (block: Block) => void; onHover: (index: number, at: { x: number; y: number }) => void; scroll: (ref: ScrollRef) => void; onScroll: (offset: number) => void }) {
  const lit = () => props.items[props.index];
  return (
    // The editor centers its bubble on the caret; Notion's menu starts at the `/`: it is moved right by `shift`
    // (half its width where the window has the room), which layout does not see.
    <PopIn side="bottom">
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, pointerEvents: "box-none", transform: [{ translateX: props.shift }] }}>
      <View testID="slash-menu" role="listbox" accessibilityLabel="Blocks" style={{ ...popupSurface(), width: MENU_WIDTH, padding: 6 }}>
        <If
          when={props.items.length > 0}
          else={<Text style={{ padding: 10, fontSize: 13, color: colors.muted }}>No blocks match</Text>}
        >
          <Scroll ref={props.scroll} onScroll={(e) => props.onScroll(e.offset.y)} style={{ maxHeight: MENU_HEIGHT }}>
            <Each of={props.items}>
              {(block, i) => (
                // The pointer moves the highlight, as the arrows do: one row is lit, not a hovered one and a chosen one.
                <View onMouseMove={(e) => i() !== props.index && props.onHover(i(), e.pagePosition)}>
                  <If when={startsGroup(props.items, i())}>
                    <Text style={{ height: HEADING, paddingHorizontal: 8, paddingTop: 8, fontSize: 11, fontWeight: "600", letterSpacing: 0.4, color: colors.muted }}>{block().group.toUpperCase()}</Text>
                  </If>
                  <Button
                    role="option"
                    selected={i() === props.index}
                    accessibilityLabel={block().title}
                    onPress={() => props.onPick(block())}
                    {...feedback()}
                    style={{
                      height: ROW,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      paddingHorizontal: 6,
                      borderRadius: 8,
                      backgroundColor: i() === props.index ? alpha(colors.text, 0.07) : undefined,
                    }}
                  >
                    <Tile icon={block().icon} />
                    <View style={{ flex: 1, gap: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{block().title}</Text>
                      <Text style={{ fontSize: 12, color: colors.muted }}>{block().hint}</Text>
                    </View>
                  </Button>
                </View>
              )}
            </Each>
          </Scroll>
        </If>
      </View>
      <If when={pointer && lit()}>
        <View testID="slash-preview" style={{ ...popupSurface(), width: PREVIEW_WIDTH, padding: 14, gap: 12 }}>
          <View style={{ height: 84, justifyContent: "center" }}>
            {/* Made again for each block: a sample is a picture of one. */}
            <Each of={[lit().id]}>{(id) => <Sample id={id()} />}</Each>
          </View>
          <Text style={{ fontSize: 12, lineHeight: 17, color: colors.muted }}>{lit().hint}</Text>
        </View>
      </If>
      </View>
    </PopIn>
  );
}

/** One of the floating toolbar's buttons. */
function BarButton(props: { icon: LucideIconName; label: string; active?: boolean; onPress: () => void }) {
  return (
    <Button
      accessibilityLabel={props.label}
      onPress={props.onPress}
      {...feedback()}
      style={{
        width: 30,
        height: 30,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: props.active ? alpha(colors.text, 0.1) : undefined,
      }}
    >
      <LucideIcon name={props.icon} size={16} tint={props.active ? colors.text : colors.muted} />
    </Button>
  );
}

function BarRule() {
  return <View style={{ width: 1, height: 16, marginHorizontal: 4, backgroundColor: colors.line }} />;
}

/** One row of a block's menu. */
function MenuRow(props: { icon: LucideIconName; label: string; tone?: string; onPress: () => void }) {
  return (
    <Button
      role="menuitem"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      {...feedback()}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 }}
    >
      <LucideIcon name={props.icon} size={16} tint={props.tone ?? colors.muted} />
      <Text style={{ fontSize: 14, color: props.tone ?? colors.text }}>{props.label}</Text>
    </Button>
  );
}

// --- The editor ----------------------------------------------------------------

/** A block's handle, in the content box's points (it is in the editor's layer over the document, so it scrolls with its block): `x` is the margin it stands in, `y` the block's first line; `left` and `width` the block's own box. */
type Handle = { start: number; x: number; y: number; left: number; width: number };

export function BlockEditorDemo() {
  // The block's keys, as Notion's: Mod-Shift-Up / Down move the caret's block, Mod-D duplicates it. An extension
  // above the keymap holds them, so no other binding takes them first.
  const keys = new RichEditorPlugin("blockKeys");
  const blockKeys = defineExtension({ name: "blockKeys", priority: 900, addProseMirrorPlugins: () => [keys] });
  // A run of whole blocks, as Notion selects them: Escape starts it at the caret's block and Shift-Up / Down grow
  // it over the siblings; Backspace deletes the run. Its keys are taken only while a run is selected, so
  // Shift-arrows select text the rest of the time.
  // Inline code stands off its neighbors: text takes a background but no padding, so a sliver of the same fill
  // goes before and after each run of code (widgets, which take no position in the document).
  const codePads = new RichEditorPlugin("codePads");
  const rangeKeys = new RichEditorPlugin("blockRange");
  const blockRange = defineExtension({ name: "blockRange", priority: 950, addProseMirrorPlugins: () => [rangeKeys, codePads] });
  const range = signal<{ anchor: number; head: number } | null>(null);
  // While the run itself is being moved or copied: the change keeps it selected.
  let moving = false;
  const editor = createRichEditor({ extensions: [StarterKit, TableKit, callout, columns, column, toggle, toggleTitle, toggleBody, slash, blockRange, blockKeys], content: DOC, format: "markdown" });
  // What the parts read: the revision follows every change of the document and the selection.
  const revision = signal(editor.revision);

  // A link under the caret shows its address and actions; the toolbar's button and Mod-K open its field.
  const link = createLinkMenu(editor, revision);

  // The `/` menu.
  const open = signal(false);
  // How far right the menu goes from the caret's middle, so that it starts at the `/` (see `SlashMenu`).
  const shift = signal(0);
  const align = (from: number) => {
    const caret = editor.pageCoordsAtPos(from) as Rect | null;
    const width = MENU_WIDTH + 8 + PREVIEW_WIDTH;
    // Half its width, less where that would pass the window's right edge.
    shift.set(pointer && caret ? Math.max(0, Math.min(width / 2, windowSize().width - 12 - caret.x - width / 2)) : 0);
  };
  const query = signal("");
  const index = signal(0);
  let seen = 0;
  // The menu's list, and where it is scrolled: the highlighted block stays in view as the arrows move it.
  let scroller: ScrollRef | undefined;
  // Where the pointer was at its last move over the editor.
  let lastPointer = { x: -1, y: -1 };
  let scrolled = 0;
  const reveal = (i: number) => {
    if (!scroller) return;
    const top = rowTop(items(), i);
    const bottom = top + ROW;
    let y = scrolled;
    if (i === 0) y = 0;
    else if (top < y) y = top - HEADING;
    else if (bottom > y + MENU_HEIGHT) y = bottom - MENU_HEIGHT + 6;
    if (y !== scrolled) scroller.scrollTo({ y, animated: false });
  };
  const items = () => {
    const q = query().trim().toLowerCase();
    return q ? BLOCKS.filter((b) => `${b.title} ${b.keywords}`.toLowerCase().includes(q)) : BLOCKS;
  };
  /** Makes the block around the caret a `block`: out of a list first, unless it is a list itself (Notion turns a to-do into a quote, not a quote in a to-do). */
  const convert = (block: Block) => {
    if (!block.list) {
      for (let i = 0; i < 4; i++) {
        const item = editor.isActive("taskItem") ? "taskItem" : editor.isActive("listItem") ? "listItem" : null;
        if (!item || !editor.run(liftListItem(item))) break;
      }
    }
    if (typeof block.apply === "function") block.apply(editor);
    else editor.run(block.apply);
  };
  const pick = (block: Block) => {
    const range = editor.suggestion("slash")?.range;
    if (!range) return;
    editor.run(deleteRange({ from: range.from, to: range.to }));
    convert(block);
    editor.focus();
  };

  // The handle of the block the pointer is over, and the menu it opened.
  const handle = signal<Handle | null>(null);
  const menu = signal<Handle | null>(null);
  const dragging = signal(false);
  // The block being carried: a preview of it follows the pointer.
  const ghost = signal<{ x: number; y: number; text: string; nest: -1 | 0 | 1; item: boolean } | null>(null);

  // The floating toolbar's selection: a range of text.
  const selected = signal(false);
  // The toolbar shows its colors in place of its buttons while one is being picked.
  const coloring = signal(false);

  const sync = () => {
    revision.set(editor.revision);
    const state = editor.suggestion("slash");
    if (state?.active) {
      const q = state.query ?? "";
      if (!open()) {
        // Each opening starts at the first block, whatever the last one picked.
        open.set(true);
        align(state.range.from);
        index.set(0);
        scrolled = 0;
      }
      if (q !== query()) {
        query.set(q);
        index.set(0);
        reveal(0);
      }
      // The keys the plugin took: the list moves or picks.
      if (state.keyCount > seen) {
        seen = state.keyCount;
        const n = items().length;
        const move = (to: number) => {
          index.set(to);
          reveal(to);
        };
        if (state.lastKey === "ArrowDown" && n) move((index() + 1) % n);
        else if (state.lastKey === "ArrowUp" && n) move((index() + n - 1) % n);
        else if (n && (state.lastKey === "Enter" || state.lastKey === "Tab")) pick(items()[Math.min(index(), n - 1)]);
      }
    } else if (open()) {
      open.set(false);
      query.set("");
      index.set(0);
      scrolled = 0;
      seen = 0;
    }
    const sel = editor.selection;
    if (range() && sel.type !== "node") selectRange(null);
    // A range of text, or the whole document (Select All): the toolbar shows and the handle goes.
    if (!(sel.type === "all" || (sel.type === "text" && sel.anchor !== sel.head))) coloring.set(false);
    selected.set((sel.type === "all" || (sel.type === "text" && sel.anchor !== sel.head)) && !editor.isActive("codeBlock"));
  };
  editor.on("revision", sync);
  const padCode = () =>
    editor.setDecorations(
      "codePads",
      markRuns(editor.doc as DocNode, "code").flatMap((run) => [
        { from: run.from, kind: "widget" as const, side: -1, spec: { class: "w-1 h-[16.5px] translate-y-[3.5px] bg-muted rounded-l" } },
        { from: run.to, kind: "widget" as const, side: 1, spec: { class: "w-1 h-[16.5px] translate-y-[3.5px] bg-muted rounded-r" } },
      ]),
    );
  padCode();
  editor.on("update", padCode);
  // A change of the document moves the blocks: the handle and its menu go until the pointer finds a block again.
  // Lists that came to stand next to each other join, however it happened (typed `1. `, a drop, a block turned
  // into a list). An undo is left alone, so the join itself can be undone.
  let depth = editor.undoDepth;
  let joining = false;
  editor.on("update", () => {
    const undone = editor.undoDepth < depth;
    depth = editor.undoDepth;
    if (!undone && !joining && !dragging()) {
      joining = true;
      joinLists(editor);
      joining = false;
      depth = editor.undoDepth;
    }
    if (range() && !moving) selectRange(null);
    if (dragging()) return;
    handle.set(null);
    menu.set(null);
  });

  /** The pointer over the editor: the handle goes to the block under it (a list's item, else the top-level block). */
  const onMove = (e: { pagePosition: { x: number; y: number } }) => {
    // The menu's rows hear a move before this does: they compare with where the pointer was.
    lastPointer = e.pagePosition;
    if (dragging() || menu()) return;
    place(e.pagePosition);
  };
  /** Puts the handle at the block under the page point `at`, if one is. */
  const place = (at: { x: number; y: number }) => {
    const pos = editor.posAtPageCoords(at);
    if (pos === null) return;
    const target = handleTarget(editor, pos);
    if (!target) return;
    const rect = editor.nodeRect(target.start) as Rect | null;
    const top = (target.top === target.start ? rect : (editor.nodeRect(target.top) as Rect | null)) ?? rect;
    if (!rect || !top) return;
    const now = handle();
    if (!now || now.start !== target.start || now.y !== rect.y || now.x !== top.x) handle.set({ start: target.start, x: top.x, y: rect.y, left: rect.x, width: rect.width });
  };

  // The grip: a press that stays put opens the block's menu (`onPress`); a move past a few points takes the block
  // and the pointer carries it (the responder is claimed only then, so a tap keeps its press).
  // How far across the drag went: a list item dropped well to the right of where it was taken goes under the
  // item above it, and well to the left comes out a level, as dragging an item across does in Notion.
  let across = 0;
  const INDENT = 32;
  /** The caret into the block at `start`'s first line. */
  const caretInto = (start: number) => {
    let inside = start + 1;
    for (let node = editor.nodeAt(start) as DocNode | null; node?.content?.[0] && node.content[0].text == null; node = node.content[0]) inside += 1;
    editor.run(setTextSelection(inside));
  };
  const nestDropped = () => {
    const sel = editor.selection;
    let start = sel.type === "node" ? (sel.anchor ?? null) : null;
    let node = start == null ? null : (editor.nodeAt(start) as DocNode | null);
    // A list's only item is carried as its list: the item is what moves across.
    if (start != null && node && LISTS.has(node.type ?? "") && node.content?.length === 1) {
      start += 1;
      node = node.content[0];
    }
    if (start == null || !node || !ITEMS.has(node.type ?? "") || Math.abs(across) < INDENT) return;
    caretInto(start);
    editor.run(across > 0 ? sinkListItem(node.type!) : liftListItem(node.type!));
  };
  const grip = (h: Handle) => ({
    onMoveShouldSetResponder: (_: unknown, g: { dx: number; dy: number }) => Math.hypot(g.dx, g.dy) > 4,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (e: { pageX: number; pageY: number }) => {
      across = -e.pageX;
      dragging.set(true);
      const node = editor.nodeAt(h.start);
      const text = node ? plainText(node) : "";
      ghost.set({ x: e.pageX, y: e.pageY, text: text.length > 80 ? `${text.slice(0, 80)}…` : text, nest: 0, item: !!node && ITEMS.has(node.type ?? "") });
      editor.dragBlock(h.start, { x: e.pageX, y: e.pageY });
      return true;
    },
    onResponderMove: (e: { pageX: number; pageY: number }) => {
      const g = ghost();
      // How far across it has gone says, while it is carried, whether the drop will nest it or take it out.
      const moved = across + e.pageX;
      if (g) ghost.set({ ...g, x: e.pageX, y: e.pageY, nest: !g.item || Math.abs(moved) < INDENT ? 0 : moved > 0 ? 1 : -1 });
      editor.dragTo({ x: e.pageX, y: e.pageY });
    },
    // The drop changes the document, and with it the handle goes.
    onResponderRelease: (e: { pageX: number }) => {
      across += e.pageX;
      editor.endDrag();
      nestDropped();
      dragging.set(false);
      ghost.set(null);
    },
    onResponderTerminate: () => {
      editor.endDrag();
      dragging.set(false);
      ghost.set(null);
    },
  });

  /** Moves the block starting at `start` one place among its siblings; the caret goes with it. */
  const move = (start: number, by: -1 | 1) => {
    const around = neighbors(editor, start);
    const node = editor.nodeAt(start);
    if (!around || !node) return false;
    const to = by < 0 ? around.before : around.after === null ? null : start + around.after;
    if (to === null) return false;
    const head = editor.selection.head ?? -1;
    const inside = head >= start && head <= start + around.size ? head - start : 1;
    const moved = editor.run(chain([deleteRange({ from: start, to: start + around.size }), insertContentAt(to, node), setTextSelection(to + inside)]));
    editor.focus();
    return moved;
  };
  /** The run's ends in the document: from its first block's start to its last block's end. */
  const span = (r: { anchor: number; head: number }) => ({ from: Math.min(r.anchor, r.head), to: blockEnd(editor, Math.max(r.anchor, r.head)) });
  /** Selects the run `r` (`null`: none) and tints its blocks. */
  const selectRange = (r: { anchor: number; head: number } | null) => {
    range.set(r);
    rangeKeys.capturing = r !== null;
    const tints = [];
    if (r) {
      const { from, to } = span(r);
      for (let pos = from; pos < to; ) {
        const node = editor.nodeAt(pos) as DocNode | null;
        if (!node) break;
        const size = nodeSize(node);
        tints.push({ from: pos, to: pos + size, kind: "node" as const, attrs: { class: "bg-primary/10 rounded-md" } });
        pos += size;
      }
    }
    editor.setDecorations("blockRange", tints);
  };
  /** The blocks of the run `r`, in order. */
  const runNodes = (r: { anchor: number; head: number }) => {
    const { from, to } = span(r);
    const nodes: DocNode[] = [];
    for (let pos = from; pos < to; ) {
      const node = editor.nodeAt(pos) as DocNode | null;
      if (!node) break;
      nodes.push(node);
      pos += nodeSize(node);
    }
    return nodes;
  };
  rangeKeys.captureKeys(["Shift-ArrowDown", "Shift-ArrowUp", "Backspace", "Delete", "Mod-d", "Mod-Shift-ArrowUp", "Mod-Shift-ArrowDown"], (key) => {
    const r = range();
    if (!r) return;
    // The run is duplicated below itself, or moved past the sibling before or after it; it stays selected.
    if (key === "Mod-d" || key === "Mod-Shift-ArrowUp" || key === "Mod-Shift-ArrowDown") {
      const { from, to } = span(r);
      const nodes = runNodes(r);
      const first = Math.min(r.anchor, r.head);
      const last = Math.max(r.anchor, r.head);
      let at: number | null;
      let done: boolean;
      moving = true;
      if (key === "Mod-d") {
        at = to;
        done = editor.run(insertContentAt(to, nodes));
      } else {
        const up = key === "Mod-Shift-ArrowUp";
        const edge = neighbors(editor, up ? first : last);
        at = !edge ? null : up ? edge.before : edge.after === null ? null : from + edge.after;
        if (at === null) return void (moving = false);
        done = editor.run(chain([deleteRange({ from, to }), insertContentAt(at, nodes)]));
      }
      // The change's `update` comes after this: the run is kept until it has.
      setTimeout(() => (moving = false), 60);
      if (!done || at === null) return;
      // The same blocks, where they are now.
      const lastStart = at + nodes.slice(0, -1).reduce((sum, n) => sum + nodeSize(n), 0);
      editor.run(setNodeSelection(at));
      selectRange(r.anchor <= r.head ? { anchor: at, head: lastStart } : { anchor: lastStart, head: at });
      return;
    }
    if (key === "Backspace" || key === "Delete") {
      const { from, to } = span(r);
      selectRange(null);
      editor.run(deleteRange({ from, to }));
      return;
    }
    const around = neighbors(editor, r.head);
    if (!around) return;
    const head = key === "Shift-ArrowDown" ? (around.after === null ? null : r.head + around.size) : around.before;
    if (head !== null) selectRange({ anchor: r.anchor, head });
  });

  /** The block the caret is in (a list's item, else the top-level block). */
  const caretBlock = () => {
    const head = editor.selection.head;
    return head == null ? null : (handleTarget(editor, head)?.start ?? null);
  };
  keys.captureKeys(["Mod-Shift-ArrowUp", "Mod-Shift-ArrowDown", "Mod-d", "Mod-k", "Escape"], (key) => {
    if (key === "Mod-k") return link.edit();
    // Escape selects the caret's block whole, as in Notion: Backspace then deletes it, and typing replaces it.
    if (key === "Escape") {
      const block = caretBlock();
      if (block !== null && editor.selection.type !== "node") {
        editor.run(setNodeSelection(block));
        selectRange({ anchor: block, head: block });
      }
      return;
    }
    const start = caretBlock();
    if (start === null) return;
    if (key === "Mod-d") {
      const node = editor.nodeAt(start);
      if (node) editor.run(insertContentAt(blockEnd(editor, start), node));
    } else move(start, key === "Mod-Shift-ArrowUp" ? -1 : 1);
  });
  keys.capturing = true;

  /** `+`: a new block below (an item of the same list below an item), with the `/` menu open in it. */
  const addBelow = (h: Handle) => {
    const end = blockEnd(editor, h.start);
    const node = editor.nodeAt(h.start);
    const item = node && ITEMS.has(node.type ?? "");
    const added = item ? { type: node.type, attrs: node.type === "taskItem" ? { checked: false } : undefined, content: [{ type: "paragraph" }] } : { type: "paragraph" };
    // Past the item's and its paragraph's opening, or the paragraph's.
    editor.run(chain([insertContentAt(end, added), setTextSelection(end + (item ? 2 : 1)), insertContent("/")]));
    editor.focus();
  };
  const turnInto = (h: Handle, block: Block) => {
    menu.set(null);
    // The caret goes into the block's first line (past the starts of the blocks around it), then the block turns.
    caretInto(h.start);
    convert(block);
    editor.focus();
  };
  const duplicate = (h: Handle) => {
    menu.set(null);
    const node = editor.nodeAt(h.start);
    if (node) editor.run(insertContentAt(blockEnd(editor, h.start), node));
    editor.focus();
  };
  const remove = (h: Handle) => {
    menu.set(null);
    editor.run(chain([setNodeSelection(h.start), command("deleteSelection")]));
    editor.focus();
  };

  /** A touch screen has no pointer to hover with: the caret's block is the one its bar acts on. */
  const atCaret = (act: (h: Handle) => void) => () => {
    const start = caretBlock();
    if (start !== null) act({ start, x: 0, y: 0, left: 0, width: 0 });
  };
  /** Tab's and Shift-Tab's work on a list item, for a keyboard without them. */
  const nest = (deeper: boolean) => () => {
    const item = editor.isActive("taskItem") ? "taskItem" : "listItem";
    editor.run(deeper ? sinkListItem(item) : liftListItem(item));
    editor.focus();
  };
  const TOUCH_ACTIONS: { icon: LucideIconName; label: string; run: () => void }[] = [
    { icon: "plus", label: "Add a block below", run: atCaret(addBelow) },
    { icon: "list-indent-decrease", label: "Outdent", run: nest(false) },
    { icon: "list-indent-increase", label: "Indent", run: nest(true) },
    { icon: "arrow-up", label: "Move block up", run: atCaret((h) => void move(h.start, -1)) },
    { icon: "arrow-down", label: "Move block down", run: atCaret((h) => void move(h.start, 1)) },
    { icon: "copy", label: "Duplicate block", run: atCaret(duplicate) },
    { icon: "trash", label: "Delete block", run: atCaret(remove) },
    { icon: "undo-2", label: "Undo", run: () => void editor.run(command("undo")) },
    { icon: "redo-2", label: "Redo", run: () => void editor.run(command("redo")) },
  ];

  // The toggles of the document's top level, where each is in the content box: their arrows stand in the layer.
  // Read again a moment after each change, once the document is laid out anew.
  const settled = signal(0);
  editor.on("update", () => void setTimeout(() => settled.set(settled() + 1), 48));
  const toggles = () => {
    revision();
    settled();
    const found: { pos: number; body: number; open: boolean; x: number; y: number }[] = [];
    // Every toggle, wherever it is nested (in a callout, a column, another toggle's body).
    const walk = (node: DocNode & { attrs?: { open?: boolean } }, pos: number) => {
      if (node.type === "toggle" && node.content?.[1]) {
        const rect = editor.nodeRect(pos) as Rect | null;
        const body = node.content[1] as DocNode & { attrs?: { open?: boolean } };
        if (rect) found.push({ pos, body: pos + 1 + nodeSize(node.content[0]), open: body.attrs?.open !== false, x: rect.x, y: rect.y });
      }
      if (node.text != null) return;
      let at = pos + 1;
      for (const child of node.content ?? []) {
        if (child.text == null) walk(child, at);
        at += nodeSize(child);
      }
    };
    walk(editor.doc as DocNode, -1);
    return found;
  };
  const flip = (t: { body: number; open: boolean }) => {
    editor.run(setNodeAttribute(t.body, "open", !t.open));
  };

  /** The editor's layer over the document: the toggles' arrows, and the handle of the block under the pointer in the margin beside it. */
  const layer = () => (
    <>
      <Each of={toggles()}>
        {(t) => (
          <Button
            accessibilityLabel={t().open ? "Collapse" : "Expand"}
            onPress={() => flip(t())}
            {...feedback()}
            style={{ position: "absolute", left: t().x, top: t().y + 2, width: 22, height: 22, borderRadius: 5, alignItems: "center", justifyContent: "center" }}
          >
            <View style={{ transform: [{ rotate: t().open ? "90deg" : "0deg" }], transitionProperty: "transform", transitionDuration: 150 }}>
              <LucideIcon name="chevron-right" size={14} tint={colors.muted} />
            </View>
          </Button>
        )}
      </Each>
      {handleLayer()}
    </>
  );
  const handleLayer = () => {
    const h = handle();
    if (!pointer || !h || open() || selected()) return undefined;
    return (
      <View style={{ position: "absolute", left: h.x - 58, top: h.y }}>
        <PopIn side="right">
          <View testID="block-handle" style={{ flexDirection: "row", alignItems: "center", gap: 2, height: 28 }}>
            <Button
              accessibilityLabel="Add a block below"
              onPress={() => addBelow(h)}
              {...feedback()}
              style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}
            >
              <LucideIcon name="plus" size={16} tint={colors.faint} />
            </Button>
            <View
              role="button"
              accessibilityLabel="Drag to move, press for the menu"
              onPress={() => openMenu(h)}
              {...feedback()}
              style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center", cursor: "grab" }}
              {...grip(h)}
            >
              <LucideIcon name="grip-vertical" size={16} tint={colors.faint} />
            </View>
          </View>
        </PopIn>
      </View>
    );
  };
  /** Opens the block's menu under its handle: where the block is on the page now. */
  const openMenu = (h: Handle) => {
    const page = editor.pageNodeRect(h.start) as Rect | null;
    if (page) menu.set({ ...h, x: page.x - (h.left - h.x), y: page.y });
  };

  /** Whether the window is wide enough for the toolbar's blocks beside its marks. */
  const roomy = () => windowSize().width >= 640;

  /** What floats by the caret or the selection: the `/` menu, else the toolbar. */
  const bubble = () => {
    if (open()) return <SlashMenu shift={shift()} items={items()} index={Math.min(index(), Math.max(items().length - 1, 0))} onPick={pick} onHover={(i, at) => {
                // A pointer at rest under the menu as it opens is not the user's hand: only a move lights a row.
                if (at.x !== lastPointer.x || at.y !== lastPointer.y) index.set(i);
              }} scroll={(r) => (scroller = r)} onScroll={(y) => (scrolled = y)} />;
    if (link.mode() !== "closed") return <PopIn side="top"><LinkBubble menu={link} /></PopIn>;
    if (!selected()) return undefined;
    revision();
    return (
      <PopIn side="top">
      <View testID="format-bar" role="toolbar" accessibilityLabel="Format" style={{ ...popupSurface(), flexDirection: "row", alignItems: "center", padding: 3, gap: 1 }}>
        <If
          when={coloring()}
          else={
            <>
              {/* A narrow window's toolbar (a phone, a small browser window) holds the marks alone: the blocks are in the `/` menu. */}
              <Each of={roomy() ? BAR_BLOCKS : []}>
                {(block) => (
                  <BarButton
                    icon={block().icon}
                    label={block().title}
                    active={!!block().node && editor.isActive(block().node![0], block().node![1])}
                    onPress={() => {
                      convert(block());
                      editor.focus();
                    }}
                  />
                )}
              </Each>
              <If when={roomy()}>
                <BarRule />
              </If>
              <Each of={MARKS}>
                {(mark) => <BarButton icon={mark().icon} label={mark().label} active={editor.isActive(mark().name)} onPress={() => editor.run(command(mark().toggle))} />}
              </Each>
              <BarButton icon="link" label="Link" onPress={link.edit} />
              <BarButton icon="type" label="Text color" onPress={() => coloring.set(true)} />
            </>
          }
        >
          {/* The colors stand in for the buttons: a phone's toolbar has no room for both. */}
          <BarButton icon="chevron-left" label="Back" onPress={() => coloring.set(false)} />
          <BarRule />
          <Each of={TEXT_COLORS}>
            {(color) => (
              <Button
                accessibilityLabel={color().label}
                onPress={() => {
                  editor.run(command("setTextStyle", { color: color().name }));
                  coloring.set(false);
                }}
                {...feedback()}
                style={{ width: 30, height: 30, borderRadius: 6, alignItems: "center", justifyContent: "center" }}
              >
                <Text class={`text-[15px] font-semibold ${color().class}`}>A</Text>
              </Button>
            )}
          </Each>
          <Button
            accessibilityLabel="Default color"
            onPress={() => {
              editor.run(command("unsetTextStyle"));
              coloring.set(false);
            }}
            {...feedback()}
            style={{ height: 30, paddingHorizontal: 8, borderRadius: 6, justifyContent: "center" }}
          >
            <Text style={{ fontSize: 12, color: colors.muted }}>Default</Text>
          </Button>
        </If>
      </View>
      </PopIn>
    );
  };

  return (
    // On a touch screen the editor ends at the keyboard, so its bar of block actions stays in reach.
    <View style={pointer ? { flex: 1, padding: 16 } : { flex: 1, paddingHorizontal: 16, paddingTop: 16, paddingBottom: "env(keyboard-inset-height)" }}>
      <View
        testID="block-editor"
        onMouseMove={pointer ? onMove : undefined}
        style={{ flex: 1, minHeight: 360, marginBottom: pointer ? 0 : 16, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, overflow: "hidden" }}
      >
        <RichEditor
          testID="block-document"
          editor={editor}
          accessibilityLabel="Document"
          placeholders={{ paragraph: "Type '/' for blocks", heading: "Heading" }}
          style={{ flex: 1 }}
          classes={{
            ...richEditorClasses,
            content: pointer ? "gap-3 pl-16 pr-10 py-8" : "gap-3 px-5 py-6",
            // A block the handle took, and the line it will drop on.
            // A rule sits as close to its neighbors as they do to each other (the document's gap is around it too).
            marks: {
              ...richEditorClasses.marks,
              highlight: "bg-primary/30 rounded",
              // Square: its ends are the slivers beside it (`codePads`).
              code: "font-mono text-sm bg-muted",
              ...Object.fromEntries(TEXT_COLORS.map((c) => [`textStyle[color=${c.name}]`, c.class])),
            },
            nodes: { ...richEditorClasses.nodes, horizontalRule: "h-px bg-border my-1", callout: "gap-2 rounded-lg border border-primary/25 bg-primary/10 px-4 py-3", columns: "flex-row gap-6", column: "flex-1 min-w-0 gap-3",
              // A toggle leaves room for its arrow; a closed body is not shown.
              toggle: "gap-1 pl-7", toggleTitle: "leading-relaxed font-medium", toggleBody: "gap-3", "toggleBody[open=false]": "hidden" },
            selectedNode: "bg-primary/10 rounded-md",
            dropCursor: "bg-primary rounded-full",
          }}
          bubbleMenu={bubble()}
          bubbleMenuPlacement={open() ? "bottom" : "top"}
          bubbleMenuOffset={6}
          contentLayer={layer()}
        />
        <If when={!pointer}>
          <View testID="block-bar" role="toolbar" accessibilityLabel="Block" style={{ borderTopWidth: 1, borderColor: colors.line }}>
            <Scroll horizontal>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 8, paddingVertical: 6 }}>
                <Each of={TOUCH_ACTIONS}>
                  {(action) => (
                    <Button
                      accessibilityLabel={action().label}
                      onPress={action().run}
                      {...feedback()}
                      style={{ width: 40, height: 40, borderRadius: 8, alignItems: "center", justifyContent: "center" }}
                    >
                      <LucideIcon name={action().icon} size={20} tint={colors.muted} />
                    </Button>
                  )}
                </Each>
              </View>
            </Scroll>
          </View>
        </If>
        <If when={ghost()}>
          {(g) => (
            <Overlay anchor={{ x: g().x, y: g().y }} placement="right" align="start" offset={14} style={{ pointerEvents: "none" }}>
              <View testID="block-ghost" style={{ ...popupSurface(), maxWidth: 360, paddingHorizontal: 12, paddingVertical: 8, opacity: 0.92 }}>
                <Text style={{ fontSize: 14, color: colors.text }}>{g().text || "Block"}</Text>
                <If when={g().nest !== 0}>
                  <View testID="block-ghost-nest" style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
                    <LucideIcon name={g().nest > 0 ? "list-indent-increase" : "list-indent-decrease"} size={14} tint={colors.accent} />
                    <Text style={{ fontSize: 12, fontWeight: "600", color: colors.accent }}>{g().nest > 0 ? "Drop to indent" : "Drop to outdent"}</Text>
                  </View>
                </If>
              </View>
            </Overlay>
          )}
        </If>
        <If when={menu()}>
          {(m) => (
            <Overlay
              anchor={{ x: m().x, y: m().y + 28 }}
              placement="bottom"
              align="start"
              offset={4}
              margin={8}
              onPressOutside={() => menu.set(null)}
              onCancel={() => menu.set(null)}
            >
              <PopIn side="bottom">
              <View testID="block-menu" role="menu" accessibilityLabel="Block" style={{ ...popupSurface(), width: 220, padding: 4 }}>
                <Text style={{ paddingHorizontal: 8, paddingTop: 4, paddingBottom: 4, fontSize: 11, fontWeight: "600", color: colors.muted }}>TURN INTO</Text>
                <Each of={BLOCKS.slice(0, 8)}>{(block) => <MenuRow icon={block().icon} label={block().title} onPress={() => turnInto(m(), block())} />}</Each>
                <View style={{ height: 1, marginVertical: 4, backgroundColor: colors.line }} />
                <MenuRow icon="arrow-up" label="Move up" onPress={() => (menu.set(null), move(m().start, -1))} />
                <MenuRow icon="arrow-down" label="Move down" onPress={() => (menu.set(null), move(m().start, 1))} />
                <MenuRow icon="copy" label="Duplicate" onPress={() => duplicate(m())} />
                <MenuRow icon="trash" label="Delete" tone={colors.down} onPress={() => remove(m())} />
              </View>
              </PopIn>
            </Overlay>
          )}
        </If>
      </View>
    </View>
  );
}
