import { mount, Scroll, signal, Text, View } from "nsh";
import {
  Button,
  Input,
  RichEditor,
  StarterKit,
  command,
  createRichEditor,
  richExtension,
  setNodeAttribute,
} from "nsh/base";
import { PostLength } from "post-editor/native";
import { type Candidate, host } from "./host";

// A short post: text with tags the server stores as HTML, in the web
// editor's format. `$` opens a search for a stock and `@` for a member; a
// pick becomes one atom of the document (`securityTag`, `mention`, from this
// app's crate), deleted and moved as a whole. A press on a stock tag opens a
// menu for its trend (0 neutral, 1 bullish, 2 bearish). `#` searches topics,
// which the web editor keeps outside the text, as a `hashtags` list: a pick
// takes the `#` away and adds a chip. `getHTML()` is the post's `content`,
// and `setContent(html, "html")` reads it back.

type Kind = "security" | "mention" | "hashtag";

/** What a pick inserts; none for a topic (a chip). */
type Node = { type: string; attrs: Record<string, unknown> };

/** What each trigger searches and the node a candidate becomes. */
const KINDS: Record<Kind, { char: string; title: string; search: (q: string) => Promise<Candidate[]>; node: ((c: Candidate) => Node) | null }> = {
  security: {
    char: "$",
    title: "股票",
    search: host.searchSecurities,
    node: (c) => ({ type: "securityTag", attrs: { counterId: c.id, name: c.name, trend: null } }),
  },
  mention: {
    char: "@",
    title: "用户",
    search: host.searchMembers,
    node: (c) => ({ type: "mention", attrs: { memberId: c.id, name: c.name } }),
  },
  hashtag: {
    char: "#",
    title: "话题",
    search: host.searchTopics,
    node: null,
  },
};
const KIND_LIST = Object.keys(KINDS) as Kind[];

/** The post the page starts from, as the server would send it back. */
const SAMPLE =
  '<p>看多 <span type="security-tag" counter_id="ST/US/NVDA" name="NVIDIA" trend="1"></span> ' +
  '<span type="mention" member_id="1001" name="Alice">@Alice</span> 的下一个季度</p>';

/** `trend`, as the web writes it: "0" neutral, "1" bullish, "2" bearish. */
const TRENDS = [
  { value: "0", label: "中立", tone: "text-foreground" },
  { value: "1", label: "看多", tone: "text-up" },
  { value: "2", label: "看空", tone: "text-down" },
];

const LOCALE = "zh-CN";

const kit = StarterKit.configure({
  // A short post is paragraphs of text: no Markdown blocks or marks.
  heading: false,
  blockquote: false,
  horizontalRule: false,
  codeBlock: false,
  image: false,
  orderedList: false,
  bulletList: false,
  listItem: false,
  taskList: false,
  taskItem: false,
  link: false,
  italic: false,
  bold: false,
  code: false,
  strike: false,
  underline: false,
  highlight: false,
  subscript: false,
  superscript: false,
  textStyle: false,
  textAlign: false,
  trailingNode: false,
  typography: false,
  listKeymap: false,
});

const classes = {
  content: "px-4 py-3",
  placeholder: "text-muted-foreground",
  nodes: {
    paragraph: "leading-relaxed",
    securityTag: "text-primary font-medium",
    "securityTag[trend=1]": "text-up font-medium",
    "securityTag[trend=2]": "text-down font-medium",
    mention: "text-info",
    hashtag: "text-primary",
  },
  // The tag a press selected, while its menu is open.
  selectedNode: "bg-muted rounded",
};

function App() {
  const editor = createRichEditor({
    // The crate's suggestions are an extension of high priority: their
    // Enter and Tab pick, before the keymap splits the paragraph.
    extensions: [kit, richExtension("securityTag"), richExtension("mention"), richExtension("hashtag"), richExtension("postSuggestions")],
    content: SAMPLE,
    format: "html",
  });

  const html = signal(editor.getHTML());
  // The web counts the text of the HTML (a stock tag's span is empty there).
  const length = () => PostLength.ofHtml(html(), LOCALE);
  const max = PostLength.max(LOCALE);

  // The open suggestion: which trigger, what was typed, the candidates and the highlighted one.
  const active = signal<Kind | null>(null);
  const query = signal("");
  const results = signal<Candidate[]>([]);
  const index = signal(0);
  const seen: Record<string, number> = {};
  let ticket = 0;

  const search = (kind: Kind, q: string) => {
    const mine = ++ticket;
    void KINDS[kind].search(q).then((found) => {
      if (mine !== ticket) return;
      results.set(found);
      index.set(0);
    });
  };

  /** The topics picked: the post's `hashtags`, outside its text. */
  const topics = signal<string[]>([]);

  const choose = (kind: Kind, candidate: Candidate) => {
    const make = KINDS[kind].node;
    if (make) {
      editor.run(command("replaceSuggestion", { key: kind, content: [make(candidate), { type: "text", text: " " }] }));
    } else {
      // A topic: the `#` and what was typed after it go, a chip comes.
      const range = editor.suggestion(kind)!.range;
      editor.run(command("deleteRange", { from: range.from, to: range.to }));
      if (!topics().includes(candidate.name)) topics.set([...topics(), candidate.name]);
    }
    editor.focus();
  };

  // The stock tag the selection is on (a press selects it), for its menu.
  const tagPos = signal<number | null>(null);
  const trend = signal<string | null>(null);

  editor.on("revision", () => {
    html.set(editor.getHTML());
    const open = KIND_LIST.find((k) => editor.suggestion(k)?.active) ?? null;
    if (open) {
      const state = editor.suggestion(open)!;
      const q = state.query ?? "";
      if (open !== active() || q !== query()) {
        active.set(open);
        query.set(q);
        search(open, q);
      }
      // Keys the plugin took while active: the list moves or picks.
      if (state.keyCount > (seen[open] ?? 0)) {
        seen[open] = state.keyCount;
        const n = results().length;
        if (state.lastKey === "ArrowDown" && n) index.set((index() + 1) % n);
        else if (state.lastKey === "ArrowUp" && n) index.set((index() + n - 1) % n);
        else if (n && (state.lastKey === "Enter" || state.lastKey === "Tab")) choose(open, results()[index()]);
      }
    } else if (active()) {
      active.set(null);
      ticket++;
    }
    const sel = editor.selection;
    if (sel.type === "node" && editor.isActive("securityTag")) {
      tagPos.set(sel.anchor ?? null);
      trend.set(((editor.getAttributes("securityTag") as { trend?: string | null }).trend ?? null) as string | null);
    } else {
      tagPos.set(null);
    }
  });

  const setTrend = (value: string) => {
    const pos = tagPos();
    if (pos === null) return;
    editor.run(setNodeAttribute(pos, "trend", value));
    editor.focus();
  };

  /** Types a trigger at the caret, as the toolbar's buttons do. */
  const trigger = (kind: Kind) => {
    editor.run(command("insertContent", { content: KINDS[kind].char }));
    editor.focus();
  };

  /** What shows by the caret or the tag: the candidates of an open suggestion, or the trend menu. */
  const bubble = () => {
    const kind = active();
    if (kind) {
      return (
        <View testID="suggestions" role="listbox" accessibilityLabel={KINDS[kind].title} class="w-64 rounded-lg border border-border bg-popover p-1 shadow-lg">
          <If when={results().length > 0} else={<Text class="px-2 py-1.5 text-sm text-muted-foreground">没有结果</Text>}>
            <Scroll style={{ maxHeight: 220 }}>
              <Each of={results()}>
                {(candidate, i) => (
                  <Button
                    role="option"
                    selected={i() === index()}
                    accessibilityLabel={`${candidate().name} ${candidate().detail}`}
                    onPress={() => choose(kind, candidate())}
                    class="flex-row items-center justify-between rounded-md px-2 py-1.5"
                    style={i() === index() ? { backgroundColor: "rgba(127,127,127,0.15)" } : undefined}
                  >
                    <Text class="text-sm text-foreground">{candidate().name}</Text>
                    <Text class="text-xs text-muted-foreground">{candidate().detail}</Text>
                  </Button>
                )}
              </Each>
            </Scroll>
          </If>
        </View>
      );
    }
    if (tagPos() !== null) {
      return (
        <View testID="trend-menu" role="menu" class="flex-row gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg">
          <Each of={TRENDS}>
            {(item) => (
              <Button role="menuitem" accessibilityLabel={item().label} onPress={() => setTrend(item().value)} class="rounded-md px-3 py-1.5">
                <Text class={trend() === item().value ? `text-sm font-semibold ${item().tone}` : "text-sm text-foreground"}>{item().label}</Text>
              </Button>
            )}
          </Each>
        </View>
      );
    }
    return undefined;
  };

  // The box that reads HTML back into the editor.
  const draft = signal(SAMPLE);
  const load = () => editor.setContent(draft(), "html");
  /** Feeds `getHTML()`'s output back in: what the server stores, edited again. */
  const reload = () => {
    draft.set(html());
    load();
  };

  return (
    <Scroll style={{ flex: 1 }}>
      <View class="gap-4 p-4">
        <View class="flex-row items-center justify-between">
          <Text class="text-lg font-semibold text-foreground">发帖</Text>
          <Text testID="count" class={length() > max ? "text-sm text-down" : "text-sm text-muted-foreground"}>{`${length()} / ${max}`}</Text>
        </View>
        <View class="overflow-hidden rounded-xl border border-border bg-card">
          <RichEditor
            testID="post-editor"
            editor={editor}
            accessibilityLabel="帖子正文"
            placeholder="分享你的看法…  $ 股票  @ 用户  # 话题"
            style={{ minHeight: 140 }}
            classes={classes}
            bubbleMenu={bubble()}
            bubbleMenuPlacement="bottom"
          />
          <View class="flex-row gap-2 border-t border-border px-3 py-2">
            <Button accessibilityLabel="插入 $" onPress={() => trigger("security")} class="rounded-md border border-border px-3 py-1">
              <Text class="text-sm text-foreground">$ 股票</Text>
            </Button>
            <Button accessibilityLabel="插入 @" onPress={() => trigger("mention")} class="rounded-md border border-border px-3 py-1">
              <Text class="text-sm text-foreground">@ 用户</Text>
            </Button>
            <Button accessibilityLabel="插入 #" onPress={() => trigger("hashtag")} class="rounded-md border border-border px-3 py-1">
              <Text class="text-sm text-foreground"># 话题</Text>
            </Button>
          </View>
        </View>

        <If when={topics().length > 0}>
          <View testID="topics" class="flex-row flex-wrap gap-2">
            <Each of={topics()}>
              {(name) => (
                <Button
                  accessibilityLabel={`移除话题 ${name()}`}
                  onPress={() => topics.set(topics().filter((t) => t !== name()))}
                  class="rounded-full border border-border px-3 py-1"
                >
                  <Text class="text-sm text-primary">{`#${name()}#  ×`}</Text>
                </Button>
              )}
            </Each>
          </View>
        </If>

        <Text class="text-xs font-medium text-muted-foreground">getHTML()</Text>
        <Text testID="html-output" class="rounded-lg bg-muted p-3 font-mono text-xs text-foreground">{html()}</Text>
        <Text testID="hashtags-output" class="font-mono text-xs text-muted-foreground">{`hashtags: ${JSON.stringify(topics())}`}</Text>

        <Text class="text-xs font-medium text-muted-foreground">读回 HTML</Text>
        <Input
          testID="html-input"
          accessibilityLabel="HTML"
          multiline
          value={draft()}
          onChange={({ value }) => draft.set(value)}
          class="min-h-[88px] rounded-lg border border-border bg-card p-3 font-mono text-xs text-foreground"
        />
        <View class="flex-row gap-2">
          <Button accessibilityLabel="载入 HTML" onPress={load} class="rounded-md bg-primary px-4 py-2">
            <Text class="text-sm font-medium text-primary-foreground">载入 HTML</Text>
          </Button>
          <Button accessibilityLabel="读回上面的输出" onPress={reload} class="rounded-md border border-border px-4 py-2">
            <Text class="text-sm text-foreground">读回上面的输出</Text>
          </Button>
        </View>
      </View>
    </Scroll>
  );
}

mount(App);
