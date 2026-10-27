import { type Bounds, cleanup, computed, List, Overlay, type Point, signal, Text, untracked, View, type YNode } from "nsh";
import { Button, DockArea, type DockAreaRef, Editor, type EditorDecoration, type EditorDiagnostic, type EditorPosition, type EditorRange, type EditorRef, type EditorSearchResult, type EditorSelection, Menu, MenuItem, MenuSeparator, TextView, Input } from "nsh/base";
import { isAvailable as hasMenus, Menu as NativeMenu, type MenuItem as NativeMenuItem } from "nsh/desktop";
import { openUrl, platform, windowSize } from "nsh";
import { keymap } from "nsh";
import { Icon, type IconName } from "../icons";
import { colors, handleThumb, Tip } from "../ui";
import { SAMPLE } from "./lsp/sample";
import { type CodeAction, type DocumentColor, LanguageServer, type Problem } from "./lsp/server";

// `nsh/base`'s `Editor` draws its text, gutter, carets and matches itself
// and keeps its own model (a rope, undo, folds, highlighting); what is
// around it is the app's: the find bar is the app's `Input`s passing a
// `search` and calling the ref, the status line reads the editor's events.
// On the TypeScript sample a simulated language server (`./lsp/server`)
// answers what the editor asks (a hover, a definition, code actions,
// completions) a little later, as a real one does over its connection;
// the other samples carry a linter's fixed diagnostics. What the server
// answers is the app's to show: diagnostics and decorations are data the
// editor draws, the hover card is an `Overlay` with a `TextView`, the code
// actions a menu at the caret.

type Language = "rust" | "typescript" | "python" | "json";

/** Mod is Command on Apple platforms (a browser on a Mac too), Control
 * elsewhere: what `keymap` calls `mod`. */
const apple = keymap.label("mod+a").startsWith("⌘");

/** A sample file of each language, with a linter's problems in it. */
const SAMPLES: Record<Language, { text: string; diagnostics: EditorDiagnostic[] }> = {
  rust: {
    text: `use std::collections::HashMap;

/// Counts the words of a text, most frequent first.
fn word_counts(text: &str) -> Vec<(&str, usize)> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for word in text.split_whitespace() {
        *counts.entry(word).or_insert(0) += 1;
    }
    let mut sorted: Vec<_> = counts.into_iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    sorted
}

fn main() {
    let unused = 42;
    for (word, count) in word_counts("the quick fox jumps over the lazy dog the end") {
        println!("{word}: {count}");
    }
}
`,
    diagnostics: [
      {
        range: { start: { line: 14, column: 8 }, end: { line: 14, column: 14 } },
        severity: "warning",
        message: "unused variable: `unused`",
        source: "rustc",
        code: "unused_variables",
      },
    ],
  },
  // The language server's file: its diagnostics are the server's.
  typescript: { text: SAMPLE, diagnostics: [] },
  python: {
    text: `from dataclasses import dataclass


@dataclass
class Point:
    x: float
    y: float

    def distance(self, other: "Point") -> float:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5


def perimeter(points):
    total = 0
    for a, b in zip(points, points[1:] + points[:1]):
        total += a.distance(b)
    return total


print(perimeter([Point(0, 0), Point(3, 0), Point(3, 4)]))
`,
    diagnostics: [
      {
        range: { start: { line: 12, column: 14 }, end: { line: 12, column: 20 } },
        severity: "info",
        message: "Missing type annotation for `points`",
        source: "mypy",
      },
    ],
  },
  json: {
    text: `{
  "name": "gallery",
  "version": "0.1.0",
  "entry": "App.tsx",
  "tailwind": {
    "theme": "theme.json"
  },
  "capabilities": ["network", "storage"],
  "debug": tru
}
`,
    diagnostics: [
      {
        range: { start: { line: 8, column: 11 }, end: { line: 8, column: 14 } },
        severity: "error",
        message: "Value expected",
        source: "json",
      },
    ],
  },
};


const LANGUAGES = [
  { value: "typescript", label: "TypeScript", file: "orders.ts" },
  { value: "rust", label: "Rust", file: "main.rs" },
  { value: "python", label: "Python", file: "shapes.py" },
  { value: "json", label: "JSON", file: "nsh.json" },
] as const;

const fileOf = (language: Language) => LANGUAGES.find((l) => l.value === language)!.file;

const SEVERITY = {
  error: { label: "error", class: "bg-destructive" },
  warning: { label: "warning", class: "bg-warn" },
  info: { label: "info", class: "bg-info" },
  hint: { label: "hint", class: "bg-muted-foreground" },
} as const;

const same = (a: EditorRange, b: EditorRange) =>
  a.start.line === b.start.line && a.start.column === b.start.column && a.end.line === b.end.line && a.end.column === b.end.column;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 || word === "info" ? "" : "s"}`;

const pointer = platform.idiom === "desktop";

/** What the hover card shows. */
interface HoverCard {
  anchor: Bounds;
  markdown: string | null;
  diagnostics: EditorDiagnostic[];
}

/** A dot of a severity's color. */
function Dot(props: { severity: EditorDiagnostic["severity"] }) {
  return <View class={`mt-[5px] size-2 rounded-full ${SEVERITY[props.severity ?? "error"].class}`} />;
}

/** A small text button of the find bar: `on` lights it while what it
 * toggles is on. */
function Tool(props: { label: string; name: string; onPress: () => void; on?: boolean }) {
  return (
    <Button
      onPress={props.onPress}
      selected={props.on}
      accessibilityLabel={props.label}
      tooltip={<Tip label={props.label} />}
      class="h-7 min-w-7 items-center justify-center rounded-md px-1.5 hover:bg-foreground/10 active:opacity-70 selected:bg-primary"
    >
      <Text class={`font-mono text-[11px] font-semibold ${props.on ? "text-primary-foreground" : "text-foreground"}`}>{props.name}</Text>
    </Button>
  );
}

/** An icon button of the toolbar, its label for screen readers and as its
 * tooltip: `on` lights it while what it toggles is on. */
function IconTool(props: { label: string; icon: IconName; onPress: () => void; on?: boolean; size?: "small" }) {
  return (
    <Button
      onPress={props.onPress}
      selected={props.on}
      accessibilityLabel={props.label}
      tooltip={<Tip label={props.label} />}
      class={`${props.size === "small" ? "size-5" : "size-7"} items-center justify-center rounded-md hover:bg-foreground/10 active:opacity-70 selected:bg-foreground/15`}
    >
      <Icon name={props.icon} size={props.size === "small" ? 13 : 16} tint={props.on ? colors.text : colors.muted} />
    </Button>
  );
}

/** An item of the options menu: a check or a dot at its end when `mark`
 * says so. */
function Item(props: { label: string; onSelect: () => void; mark?: "check" | "dot" | null; shortcut?: string; keepOpen?: boolean }) {
  return (
    <MenuItem
      onSelect={props.onSelect}
      closeOnSelect={!props.keepOpen}
      class={`flex-row items-center gap-2 rounded-md px-2 hover:bg-foreground/10 active:bg-foreground/15 ${pointer ? "h-8" : "h-11"}`}
    >
      <Text class="shrink grow text-sm text-popover-foreground">{props.label}</Text>
      <If when={pointer && props.shortcut}>
        <Text class="font-mono text-xs text-muted-foreground">{keymap.label(props.shortcut!)}</Text>
      </If>
      <View class="w-4 items-center">
        <If when={props.mark === "check"}>
          <Icon name="check" size={14} tint={colors.accent} />
        </If>
        <If when={props.mark === "dot"}>
          <View class="size-[7px] rounded-full" style={{ backgroundColor: colors.accent }} />
        </If>
      </View>
    </MenuItem>
  );
}

/** A group's title in the options menu. */
function Label(props: { text: string }) {
  return <Text class="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{props.text}</Text>;
}

/** The menus' popup on desktops, their sheet on touch screens. */
const popup = pointer ? "w-64 rounded-lg border border-border bg-popover p-1.5 shadow-lg" : "rounded-t-2xl bg-popover px-2.5 pb-8 pt-2.5";

const field = "h-7 min-w-[100px] flex-1 rounded-md border border-border bg-card px-2 text-[12px] text-foreground placeholder:text-muted-foreground focus:border-ring";

/**
 * Editor: `nsh/base`'s `Editor` with a sample file per language in a
 * `DockArea`, its problems in a bottom dock (resized and hidden; a sheet
 * at phone width) and a status line under them; the language, soft wrap
 * and line numbers chosen from an options menu; a find bar of the app's
 * own inputs, opened with Mod+F and closed with Escape (case, whole word
 * and regular expression toggles, next and previous, replace and replace
 * all through the ref); a context menu of editing commands. On the
 * TypeScript sample a simulated language server: diagnostics after each
 * pause in typing, hover cards with the symbol's signature and docs, go
 * to definition (Mod-hover underlines, Mod-click and F12 go), quick fixes
 * and refactorings (Mod+.), the colors of hex literals, completion (as you
 * type, after `.`, Ctrl+Space) and inline completion (Tab).
 */
export function EditorDemo() {
  const language = signal<Language>("typescript");
  const softWrap = signal(false);
  const lineNumbers = signal(true);
  const finding = signal(false);
  const query = signal("");
  const replacement = signal("");
  const caseSensitive = signal(false);
  const wholeWord = signal(false);
  const regex = signal(false);
  const selections = signal<EditorSelection[]>([]);
  const result = signal<EditorSearchResult>({ count: 0 });
  const last = signal("—");
  // Each sample's text as last edited, so switching back finds it as it was.
  const texts: Partial<Record<Language, string>> = {};
  let editor: EditorRef | undefined;
  let area: DockAreaRef | undefined;
  let toolbar: YNode | undefined;
  // Whether the problems' dock shows (`onDockOpenChange`): open in the
  // full presentation, none at first at compact width, where the area is
  // less than 600 wide (a phone's window).
  const problemsShown = signal(untracked(windowSize).width >= 600);
  const server = new LanguageServer();
  server.change(SAMPLE);
  const found = signal<Problem[]>([]);
  const literals = signal<DocumentColor[]>([]);
  const hover = signal<HoverCard | null>(null);
  // The declaration go to definition just went to, lit for a moment.
  const flash = signal<EditorRange | null>(null);
  const analyzing = signal(false);
  const quickFixes = signal<{ anchor: Point; actions: CodeAction[] } | null>(null);
  const typescript = () => language() === "typescript";

  // The server's diagnostics and colors, asked for again after each pause
  // in typing. The server keeps the TypeScript text while another sample
  // is shown, so its answers stay good for when it comes back.
  let lintTimer: ReturnType<typeof setTimeout> | undefined;
  let version = 0;
  const analyze = async () => {
    const asked = ++version;
    analyzing.set(true);
    const [problems, colorsFound] = await Promise.all([server.diagnostics(), server.colors()]);
    // An answer about an older text: a newer one is on its way.
    if (asked !== version) return;
    found.set(problems);
    literals.set(colorsFound);
    analyzing.set(false);
  };
  void analyze();
  const changed = (value: string) => {
    server.change(value);
    analyzing.set(true);
    clearTimeout(lintTimer);
    lintTimer = setTimeout(analyze, 300);
  };

  // The problems of the sample shown: the server's, or the linter's fixed
  // ones (which have no fixes).
  const problems = computed<Problem[]>(() =>
    typescript() ? found() : SAMPLES[language()].diagnostics.map((diagnostic) => ({ diagnostic, fixes: [] })),
  );
  const diagnostics = computed(() => problems().map((p) => p.diagnostic));
  const count = (severity: EditorDiagnostic["severity"]) => diagnostics().filter((d) => (d.severity ?? "error") === severity).length;
  const decorations = computed<EditorDecoration[]>(() => {
    if (!typescript()) return [];
    const out: EditorDecoration[] = literals().map(({ range, color }) => ({ range, style: { backgroundColor: `${color}40` } }));
    const lit = flash();
    if (lit) out.push({ range: lit, class: "bg-brand/25", lineClass: "bg-brand/10" });
    return out;
  });

  const caret = () => {
    const primary = selections().at(-1);
    if (!primary) return "Ln 1, Col 1";
    const more = selections().length > 1 ? ` · ${selections().length} carets` : "";
    return `Ln ${primary.head.line + 1}, Col ${primary.head.column + 1}${more}`;
  };
  const matches = () => {
    const r = result();
    if (r.error) return "Invalid pattern";
    if (!query()) return "";
    if (r.count === 0) return "No results";
    return r.current === undefined || r.current === null ? `${r.count} matches` : `${r.current + 1} of ${r.count}`;
  };

  // A code action: an editor command, or the server's edits applied as one
  // edit undo takes back in one step.
  const apply = (action: CodeAction) => {
    if (!editor) return;
    if (action.command) editor.run(action.command);
    if (action.edits?.length) editor.edit(action.edits);
    editor.focus();
    last.set(action.title);
  };

  const showDefinition = (target: { name: string; range: EditorRange } | null) => {
    if (!target || !editor) {
      last.set("No definition found");
      return;
    }
    const at = target.range.start;
    editor.setSelections([{ anchor: at, head: at }]);
    editor.revealPosition(at, true);
    flash.set(target.range);
    setTimeout(() => flash() === target.range && flash.set(null), 900);
    last.set(`Definition of ${target.name} at ${at.line + 1}:${at.column + 1}`);
  };

  /** A menu of `actions`: the quick fixes, then the rest. */
  const menuItems = (actions: CodeAction[]): NativeMenuItem[] => {
    const fixes = actions.filter((a) => a.kind === "quickfix");
    const rest = actions.filter((a) => a.kind !== "quickfix");
    const item = (a: CodeAction): NativeMenuItem => ({ label: a.title, onSelect: () => apply(a) });
    return [...fixes.map(item), ...(fixes.length > 0 && rest.length > 0 ? [{ type: "separator" } as const] : []), ...rest.map(item)];
  };

  const contextMenu = async (position: EditorPosition, x: number, y: number) => {
    if (!hasMenus) return;
    const fixes = typescript() ? (await server.codeActions({ start: position, end: position }, problems())).filter((a) => a.kind === "quickfix") : [];
    const items: NativeMenuItem[] = [];
    if (typescript()) {
      items.push({ label: "Go to Definition", shortcut: "f12", onSelect: () => void server.definition(position).then(showDefinition) }, { type: "separator" });
    }
    if (fixes.length > 0) items.push(...menuItems(fixes), { type: "separator" });
    items.push(
      { label: "Cut", onSelect: () => editor?.run("cut") },
      { label: "Copy", onSelect: () => editor?.run("copy") },
      { label: "Paste", onSelect: () => editor?.run("paste") },
      { label: "Select All", onSelect: () => editor?.run("selectAll") },
      { type: "separator" },
      { label: "Toggle Comment", onSelect: () => editor?.run("toggleComment") },
      { label: "Fold All", onSelect: () => editor?.run("foldAll") },
      { label: "Unfold All", onSelect: () => editor?.run("unfoldAll") },
    );
    void NativeMenu.popup(items, { x, y });
  };

  // Completion has no default keys: the app picks them.
  keymap.bind("ctrl+space", () => editor?.showCompletions());

  // The hover card stays while the pointer is over it, so its text can be
  // selected and its fixes pressed: leaving the word closes it a moment
  // later unless the pointer went onto the card.
  let hoverAsked = 0;
  let overCard = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSoon = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!overCard) hover.set(null);
    }, 250);
  };

  cleanup(() => {
    clearTimeout(lintTimer);
    clearTimeout(closeTimer);
  });

  // A diagnostic code's page (a lint rule's), in the browser.
  const openRule = async (href: string) => {
    try {
      if (!(await openUrl(href))) last.set("No app opens links");
    } catch (error) {
      last.set(String(error));
    }
  };

  const fixesFor = (d: EditorDiagnostic) => problems().find((p) => p.diagnostic.message === d.message && same(p.diagnostic.range, d.range))?.fixes ?? [];


  // The keys, as the options menu lists them.
  const tips = () =>
    typescript()
      ? [
          `${keymap.label("ctrl+space")} completions (also as you type and after a dot)`,
          "Tab takes the gray suggestion",
          ...(pointer ? ["Hover for docs and problems", `Hold ${apple ? "⌘" : "Ctrl"} over a name to underline it`] : []),
          `${keymap.label("f12")} or ${apple ? "⌘" : "Ctrl"}-click: go to definition`,
          `${keymap.label("mod+.")} code actions`,
        ]
      : [`${keymap.label("mod+.")} code actions`, pointer ? "Right-click for commands" : "Long-press to select"];

  // The find bar opens with Mod+F (the selection, when there is one,
  // becomes its query) and closes with Escape or its close button, giving
  // the focus back to the text.
  const openFind = () => {
    const primary = selections().at(-1);
    if (primary && (primary.anchor.line !== primary.head.line || primary.anchor.column !== primary.head.column)) editor?.run("findWithSelection");
    finding.set(true);
  };
  const closeFind = () => {
    finding.set(false);
    query.set("");
    editor?.focus();
  };
  keymap.bind("mod+f", openFind);

  /** The find bar, while it is open: an overlay under the toolbar's end,
   * over the editor's first lines (the window's width at phone width);
   * Escape closes it. */
  function FindBar() {
    return (
      <Overlay anchor={toolbar} placement="bottom" align="end" offset={4} margin={8} onCancel={closeFind}>
        <View
          class="gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg"
          style={{ width: Math.min(440, windowSize().width - 16) }}
        >
          <View class="flex-row items-center gap-0.5">
            <Input
              ref={(node: YNode) => node.focus()}
              value={query()}
              onChange={(value) => query.set(value)}
              onSubmit={() => editor?.run("findNext")}
              submitBehavior="submit"
              placeholder="Find"
              accessibilityLabel="Find"
              autoCapitalize="none"
              autoCorrect={false}
              class={field}
            />
            <Text numberOfLines={1} class="px-1 font-mono text-[11px] tabular-nums text-muted-foreground">
              {matches()}
            </Text>
            <Tool label="Match case" name="Aa" on={caseSensitive()} onPress={() => caseSensitive.set(!caseSensitive())} />
            <Tool label="Whole word" name="W" on={wholeWord()} onPress={() => wholeWord.set(!wholeWord())} />
            <Tool label="Regular expression" name=".*" on={regex()} onPress={() => regex.set(!regex())} />
            <IconTool label="Previous match" icon="arrow-up" onPress={() => editor?.run("findPrevious")} />
            <IconTool label="Next match" icon="arrow-down" onPress={() => editor?.run("findNext")} />
            <IconTool label="Close the find bar" icon="close" onPress={closeFind} />
          </View>
          <View class="flex-row items-center gap-0.5">
            <Input
              value={replacement()}
              onChange={(value) => replacement.set(value)}
              onSubmit={() => editor?.replace(replacement())}
              submitBehavior="submit"
              placeholder="Replace"
              accessibilityLabel="Replace"
              autoCapitalize="none"
              autoCorrect={false}
              class={field}
            />
            <IconTool label="Replace" icon="replace" onPress={() => editor?.replace(replacement())} />
            <IconTool
              label="Replace all"
              icon="replace-all"
              onPress={async () => {
                const n = (await editor?.replaceAll(replacement())) ?? 0;
                last.set(`Replaced ${n}`);
              }}
            />
          </View>
        </View>
      </Overlay>
    );
  }

  /** The editor of the sample shown. */
  function Source() {
    // A sample of its own per language: switching remounts the editor, so
    // each keeps its undo history out of the others'.
    return (
      <View class="flex-1 bg-card">
        {() => {
          const lang = language();
          const lsp = lang === "typescript";
          return (
            <Editor
              ref={(r) => (editor = r)}
              defaultValue={texts[lang] ?? SAMPLES[lang].text}
              language={lang}
              softWrap={softWrap()}
              lineNumbers={lineNumbers()}
              diagnostics={diagnostics()}
              decorations={decorations()}
              search={{ query: finding() ? query() : "", caseSensitive: caseSensitive(), wholeWord: wholeWord(), regex: regex() }}
              accessibilityLabel={`${lang} source`}
              completion={lsp}
              completionTriggerCharacters={["."]}
              inlineCompletionDelay={150}
              onChange={(value) => {
                texts[lang] = value;
                if (lsp) changed(value);
              }}
              onSelectionChange={(value) => selections.set(value)}
              onSearchChange={(value) => result.set(value)}
              onFindWithSelection={(value) => {
                query.set(value);
                finding.set(true);
              }}
              onLineNumberPress={(line) => last.set(`Line ${line + 1} pressed`)}
              onContextMenu={(e) => void contextMenu(e.position, e.x, e.y)}
              onHover={async (e) => {
                clearTimeout(closeTimer);
                const asked = ++hoverAsked;
                const answer = lsp ? await server.hover(e.position) : null;
                if (asked !== hoverAsked) return;
                hover.set(answer || e.diagnostics.length > 0 ? { anchor: e.pageBounds, markdown: answer?.markdown ?? null, diagnostics: e.diagnostics } : null);
              }}
              onHoverEnd={() => {
                hoverAsked++;
                closeSoon();
              }}
              onDefinitionRequest={async (e) => {
                const target = lsp ? await server.definition(e.position) : null;
                // Mod held over a name: underlined when it has a definition
                // (the editor drops an answer to an older request).
                if (e.trigger === "hover") {
                  if (target) editor?.presentDefinitionLink(e.id, e.range);
                } else showDefinition(target);
              }}
              onCodeActionRequest={async (e) => {
                const actions = await server.codeActions(e.range, problems());
                const page = e.bounds?.pageBounds;
                if (!page) return;
                const anchor = { x: page.origin.x, y: page.origin.y + page.size.height };
                if (hasMenus) void NativeMenu.popup(menuItems(actions), anchor);
                else quickFixes.set({ anchor, actions });
              }}
              onCompletionRequest={async (e) => {
                const answer = await server.completion(e);
                editor?.presentCompletions(e.id, answer.items, answer.incomplete);
              }}
              onCompletionAccept={(e) => last.set(`Completed ${e.item.label}`)}
              onInlineCompletionRequest={async (e) => {
                const suggestion = await server.inlineCompletion(e.position);
                if (suggestion) editor?.presentInlineCompletion(e.id, suggestion);
              }}
              class="flex-1"
            />
          );
        }}
      </View>
    );
  }

  /** The problems of the sample shown: pressing one puts the caret on it. */
  function Problems() {
    return (
      // A list, not a column of every row: a long file has thousands of
      // problems, and only those in view are made.
      <If when={problems().length > 0} else={<Text class="px-3 py-2 text-xs text-muted-foreground">No problems</Text>}>
        <List each={problems()} estimatedItemSize={24} class="flex-1" contentClass="py-1">
          {(p) => (
            <Button
              onPress={() => {
                const at = p().diagnostic.range.start;
                editor?.setSelections([{ anchor: at, head: at }]);
                editor?.revealPosition(at, true);
                editor?.focus();
              }}
              accessibilityLabel={p().diagnostic.message}
              class="flex-row gap-2 px-3 py-1 hover:bg-foreground/10 active:bg-foreground/15"
            >
              <Dot severity={p().diagnostic.severity} />
              <Text numberOfLines={1} class="flex-1 text-xs text-foreground">
                {p().diagnostic.message}
              </Text>
              <Text class="font-mono text-[11px] tabular-nums text-muted-foreground">{`${p().diagnostic.range.start.line + 1}:${p().diagnostic.range.start.column + 1}`}</Text>
            </Button>
          )}
        </List>
      </If>
    );
  }

  return (
    <View class="flex-1 bg-background">
      <View ref={(node: YNode) => (toolbar = node)} class="h-10 flex-row items-center gap-0.5 border-b border-border px-1.5">
        <Menu
          offset={4}
          margin={8}
          popupClass={popup}
          backdropClass="bg-black/40"
          trigger={
            <View
              accessibilityLabel="Language"
              tooltip={<Tip label="Language" />}
              class="h-7 flex-row items-center gap-1.5 rounded-md px-1.5 hover:bg-foreground/10 active:opacity-70"
            >
              <Icon name="code" size={16} tint={colors.muted} />
              <Text class="text-xs font-medium text-foreground">{LANGUAGES.find((l) => l.value === language())!.label}</Text>
            </View>
          }
        >
          <Each of={LANGUAGES}>
            {(l) => (
              <Item
                label={l().label}
                mark={language() === l().value ? "dot" : null}
                onSelect={() => {
                  hover.set(null);
                  language.set(l().value);
                }}
              />
            )}
          </Each>
        </Menu>
        <View class="flex-1" />
        <IconTool label="Find and replace" icon="search" on={finding()} onPress={() => (finding() ? closeFind() : openFind())} />
        <Menu
          align="end"
          offset={4}
          margin={8}
          popupClass={popup}
          backdropClass="bg-black/40"
          trigger={
            <View accessibilityLabel="Editor options" tooltip={<Tip label="Editor options" />} class="size-7 items-center justify-center rounded-md hover:bg-foreground/10 active:opacity-70">
              <Icon name="sliders" size={16} tint={colors.muted} />
            </View>
          }
        >
          <Item label="Soft wrap" mark={softWrap() ? "check" : null} keepOpen onSelect={() => softWrap.set(!softWrap())} />
          <Item label="Line numbers" mark={lineNumbers() ? "check" : null} keepOpen onSelect={() => lineNumbers.set(!lineNumbers())} />
          <Item label="Problems" mark={problemsShown() ? "check" : null} onSelect={() => area?.toggleDock("bottom")} />
          <Item label="Find and Replace" shortcut="mod+f" onSelect={openFind} />
          <MenuSeparator class="mx-1 my-1 h-px bg-border" />
          <Label text={typescript() ? "TypeScript language server" : "Keys"} />
          <Each of={tips()}>{(tip) => <Text class="px-2 py-0.5 text-xs text-muted-foreground">{tip()}</Text>}</Each>
        </Menu>
      </View>

      <If when={finding()}>
        <FindBar />
      </If>

      <View class="flex-1">
        <DockArea
          ref={(r) => (area = r)}
          class="flex-1"
          defaultLayout={{
            center: { type: "tabs", panels: ["editor"] },
            bottom: { layout: { type: "tabs", panels: ["problems"] }, size: 120 },
          }}
          panels={[
            { id: "editor", closable: false },
            { id: "problems", closable: false },
          ]}
          onDockOpenChange={(placement, open) => placement === "bottom" && problemsShown.set(open)}
          groupClass="flex-1 bg-card"
          tabBarClass="flex-row border-b border-border"
          contentClass="flex-1"
          handleAccessibilityLabel="Resize the problems"
          handleClass="basis-px bg-border"
          handleThumbClass={handleThumb}
          dockClass="bg-card"
          sheetClass="h-72 rounded-t-2xl border-t border-border bg-card"
          backdropClass="bg-black/40"
          renderTab={(tab) => (
            <View class="h-7 flex-row items-center gap-2 px-3">
              <Text numberOfLines={1} class={`text-xs font-medium ${tab.active ? "text-foreground" : "text-muted-foreground"}`}>
                {tab.panel === "editor" ? fileOf(language()) : `Problems ${problems().length}`}
              </Text>
              <If when={tab.active}>
                <View pointerEvents="none" class="absolute bottom-0 left-3 right-3 h-0.5 rounded-full bg-brand" />
              </If>
            </View>
          )}
          renderPanel={(panel) => (panel.id === "editor" ? <Source /> : <Problems />)}
        />
      </View>

      <If when={hover()}>
        {(card) => (
          <Overlay anchor={card().anchor} placement="top" align="start" offset={4} margin={8}>
            <View
              onHoverIn={() => {
                overCard = true;
                clearTimeout(closeTimer);
              }}
              onHoverOut={() => {
                overCard = false;
                closeSoon();
              }}
              testID="hover-card"
              class="gap-2 rounded-lg border border-border bg-popover p-3 shadow-lg"
              // A width of its own: an overlay fits its content, which
              // would leave the message's growing text no room.
              style={{ width: Math.min(400, windowSize().width - 16) }}
            >
              <Each of={card().diagnostics}>
                {(d) => (
                  <View class="gap-1.5">
                    <View class="flex-row gap-2">
                      <Dot severity={d().severity} />
                      <View class="flex-1 gap-0.5">
                        <Text class="text-[13px] text-popover-foreground">{d().message}</Text>
                        <View class="flex-row flex-wrap items-center gap-1">
                          <Text class="text-xs text-muted-foreground">{d().source ?? ""}</Text>
                          <If when={d().code}>
                            {(code) => (
                              <If when={d().codeDescription} else={<Text class="text-xs text-muted-foreground">{`(${code()})`}</Text>}>
                                {(description) => (
                                  <Button
                                    onPress={() => void openRule(description().href)}
                                    accessibilityLabel={`Open the description of ${code()}`}
                                    class="rounded-sm active:opacity-70"
                                  >
                                    <Text class="text-xs text-info underline">{code()}</Text>
                                  </Button>
                                )}
                              </If>
                            )}
                          </If>
                        </View>
                      </View>
                    </View>
                    <View class="flex-row flex-wrap gap-1.5 pl-4">
                      <Each of={fixesFor(d())}>
                        {(fix) => (
                          <Button
                            onPress={() => {
                              apply(fix());
                              hover.set(null);
                            }}
                            class="rounded-md bg-accent px-2 py-1 hover:bg-foreground/15 active:opacity-70"
                          >
                            <Text class="text-xs text-accent-foreground">{fix().title}</Text>
                          </Button>
                        )}
                      </Each>
                    </View>
                  </View>
                )}
              </Each>
              <If when={card().markdown}>
                {(markdown) => <TextView markdown={markdown()} selectable class={card().diagnostics.length > 0 ? "border-t border-border pt-2" : ""} />}
              </If>
            </View>
          </Overlay>
        )}
      </If>

      <If when={quickFixes()}>
        {(menu) => (
          <Overlay anchor={menu().anchor} placement="bottom" align="start" margin={8} onPressOutside={() => quickFixes.set(null)} onCancel={() => quickFixes.set(null)}>
            <View role="menu" class="min-w-56 rounded-lg border border-border bg-popover p-1 shadow-lg">
              <Each of={menu().actions}>
                {(action) => (
                  <Button
                    onPress={() => {
                      quickFixes.set(null);
                      apply(action());
                    }}
                    class="rounded-md px-3 py-2 hover:bg-foreground/10 active:bg-foreground/15"
                  >
                    <Text class="text-[13px] text-popover-foreground">{action().title}</Text>
                  </Button>
                )}
              </Each>
            </View>
          </Overlay>
        )}
      </If>

      <View class="h-6 flex-row items-center gap-3 overflow-hidden border-t border-border pl-2.5 pr-1">
        <Text numberOfLines={1} class="font-mono text-[11px] tabular-nums text-foreground">
          {caret()}
        </Text>
        <Text numberOfLines={1} class="font-mono text-[11px] text-destructive">
          {plural(count("error"), "error")}
        </Text>
        <Text numberOfLines={1} class="font-mono text-[11px] text-warn">
          {plural(count("warning"), "warning")}
        </Text>
        <Text numberOfLines={1} class="font-mono text-[11px] text-info">
          {plural(count("info"), "info")}
        </Text>
        <Text numberOfLines={1} class="min-w-0 shrink font-mono text-[11px] text-muted-foreground">
          {last()}
        </Text>
        <Text numberOfLines={1} class="ml-auto min-w-0 shrink font-mono text-[11px] text-muted-foreground">
          {typescript() && analyzing() ? "Analyzing…" : LANGUAGES.find((l) => l.value === language())!.label}
        </Text>
        <IconTool label="Toggle problems" icon="diagnostics" size="small" on={problemsShown()} onPress={() => area?.toggleDock("bottom")} />
      </View>
    </View>
  );
}
