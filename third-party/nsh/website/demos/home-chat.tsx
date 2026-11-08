// The home page's chat: one small AI chat app, the same code at each
// idiom, drawn as native chat apps are: a black or white page, what you send
// in a neutral bubble, replies in plain text, and glass controls over the
// thread (`glassEffect`: Liquid Glass on iOS 26 and macOS 26, a blur
// elsewhere). On a phone the thread fills the screen under glass buttons and
// a glass composer; with a pointer it is a panel beside the sidebar; in a
// terminal a dense grid with a prompt box. It plays a short exchange on load
// and answers what is typed.
import { colorScheme, createAnimatedValue, Easing, type JSX, mount, platform, Scroll, type ScrollRef, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { desktop, Icon } from "./palette";

type Msg = { id: number; from: "user" | "assistant"; text: string; code?: string[] };

const OPENING: Msg[] = [
  { id: 0, from: "user", text: "Show me a counter in NSH" },
  {
    id: 1,
    from: "assistant",
    text: "A signal holds the count; only the `Text` that reads it updates when you press.",
    code: ['import { mount, signal, Text, View } from "nsh";', "", "const count = signal(0);", "mount(() => (", "  <View onPress={() => count.set(count() + 1)}>", "    <Text>{count()}</Text>", "  </View>", "));"],
  },
  { id: 2, from: "user", text: "What makes an NSH app native?" },
  {
    id: 3,
    from: "assistant",
    text: "Every element is the platform's own view: **UIKit** on iOS, **Android views**, **AppKit** on macOS and **GTK 4** on Linux. Your TSX describes them; layout, text and the reactive graph run in **Rust**.",
  },
];
const FOLLOW_UP = "And the glass around this chat?";
const GLASS = [
  "It's **Liquid Glass**, one `glassEffect` style. iOS 26 and macOS 26 draw the system's material; elsewhere it blurs what scrolls beneath.",
  "• The buttons and the composer float over the thread",
  "• Messages pass under them as you scroll",
  "• The same code at every idiom",
].join("\n");
const SCRIPTED = "This reply is scripted for the demo, but the input, the scrolling thread and the glass around them are the platform's own.";

const CHATS = ["What makes an NSH app native?", "Plot a week of NSH", "Signed packages, explained", "A sheet with two detents", "Taffy grid vs flex"];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const tui = platform.idiom === "terminal";

/** The chat's colors in the appearance shown: a black or white page, a
 * neutral gray for what you send, the reply in plain text. */
const sys = () => {
  const dark = colorScheme() === "dark";
  return {
    dark,
    // A desktop window in the page's own blue-black; a phone's OLED black.
    background: dark ? (desktop ? "#15171c" : "#000000") : "#ffffff",
    sidebar: dark ? "#0e1015" : "#f9f9f9",
    bubble: dark ? (desktop ? "#262931" : "#303030") : "#f2f2f2",
    label: dark ? "#ffffff" : "#0d0d0d",
    secondary: dark ? "#b4b4b4" : "#5d5d5d",
    tertiary: dark ? "#8e8e8e" : "#8f8f8f",
    // A terminal draws lines in one solid color.
    line: tui ? (dark ? "#4a4a4f" : "#c8c8cc") : dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)",
    code: dark ? (desktop ? "#0e1015" : "#171717") : "#f7f7f7",
    accent: dark ? "#ffffff" : "#000000",
    onAccent: dark ? "#000000" : "#ffffff",
    link: dark ? "#7ab7ff" : "#0069d9",
    selection: dark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.05)",
  };
};

/** A floating control over the thread: Liquid Glass where the system draws
 * it (iOS 26, macOS 26), elsewhere a blur of what scrolls beneath, a thin
 * tint and a hairline edge. */
const glass = (radius: number) => ({
  borderRadius: radius,
  borderCurve: "continuous" as const,
  borderWidth: 1,
  borderColor: sys().dark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.07)",
  backgroundColor: sys().dark ? "rgba(36,36,38,0.6)" : "rgba(255,255,255,0.62)",
  backdropFilter: "blur(20px)",
  glassEffect: "regular" as const,
  boxShadow: sys().dark ? "0 4px 18px rgba(0,0,0,0.4)" : "0 4px 18px rgba(0,0,0,0.08)",
});

/** A reply's text: paragraphs and `•` lines, with `**bold**` and `code`. */
function Rich(props: { text: string }) {
  const size = desktop ? 13 : 15;
  const lh = desktop ? 20 : 22;
  return (
    <View style={{ gap: desktop ? 6 : 8 }}>
      <Each of={props.text.split("\n")}>
        {(line) => {
          const bullet = () => line().startsWith("• ");
          const parts = () => (bullet() ? line().slice(2) : line()).split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean);
          return (
            <View style={{ flexDirection: "row", gap: 8, paddingLeft: bullet() && !tui ? 4 : 0 }}>
              <If when={bullet()}>
                <Text style={{ fontSize: size, lineHeight: lh, color: sys().label }}>•</Text>
              </If>
              <Text style={{ flex: 1, fontSize: size, lineHeight: lh, letterSpacing: desktop ? 0 : -0.2, color: sys().label }}>
                <Each of={parts()}>
                  {(part) =>
                    part().startsWith("**") ? (
                      <Text style={{ fontWeight: "600" }}>{part().slice(2, -2)}</Text>
                    ) : part().startsWith("`") ? (
                      <Text style={{ fontFamily: "monospace", fontSize: size - 2, color: tui ? sys().link : sys().label, backgroundColor: tui ? "transparent" : sys().bubble }}>{part().slice(1, -1)}</Text>
                    ) : (
                      <Text>{part()}</Text>
                    )
                  }
                </Each>
              </Text>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

/** Fades and lifts a message in as it arrives, natively. */
function Rise(props: { children: JSX.Element }) {
  const t = createAnimatedValue(0);
  t.timing(1, { duration: 380, easing: Easing.out(Easing.cubic) });
  return <View style={{ opacity: t, transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>{props.children}</View>;
}

/** Three dots in a row, the "more" of a toolbar. */
function More(props: { tint: string; size?: number }) {
  const d = props.size ?? 4;
  return (
    <View style={{ flexDirection: "row", gap: d }}>
      <Each of={[0, 1, 2]}>{() => <View style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: props.tint }} />}</Each>
    </View>
  );
}

/** A reply's actions under it: copy, share, more. */
function Actions() {
  const tint = sys().secondary;
  const hit = { width: 24, height: 24, borderRadius: 6, alignItems: "center" as const, justifyContent: "center" as const };
  return (
    <View style={{ flexDirection: "row", gap: 2, marginLeft: -5, marginTop: -4 }}>
      <View hoverStyle={{ backgroundColor: sys().selection }} style={hit}><Icon name="copy" size={desktop ? 14 : 15} tint={tint} /></View>
      <View hoverStyle={{ backgroundColor: sys().selection }} style={hit}><Icon name="share" size={desktop ? 14 : 15} tint={tint} /></View>
      <View hoverStyle={{ backgroundColor: sys().selection }} style={hit}><More tint={tint} size={2.5} /></View>
    </View>
  );
}

function Message(props: { msg: Msg }) {
  if (props.msg.from === "user") {
    // What you send: a neutral bubble at the trailing edge.
    return (
      <View style={{ alignSelf: "flex-end", maxWidth: tui ? "80%" : "78%", paddingHorizontal: tui ? 2 : desktop ? 12 : 14, paddingVertical: tui ? 0 : desktop ? 6 : 8, borderRadius: desktop ? 16 : 19, borderCurve: "continuous", backgroundColor: sys().bubble }}>
        <Text style={{ fontSize: desktop ? 13 : 15, lineHeight: desktop ? 19 : 21, letterSpacing: desktop ? 0 : -0.2, color: sys().label }}>{props.msg.text}</Text>
      </View>
    );
  }
  return (
    <View style={{ gap: tui ? 1 : 10 }}>
      <Rich text={props.msg.text} />
      <If when={props.msg.code}>
        <View style={{ paddingHorizontal: tui ? 2 : 12, paddingVertical: tui ? 0 : 10, borderRadius: 12, borderCurve: "continuous", backgroundColor: sys().code, borderWidth: tui ? 0 : 1, borderColor: sys().line }}>
          <Each of={props.msg.code ?? []}>
            {(line) => <Text style={{ numberOfLines: 1, fontFamily: "monospace", fontSize: desktop ? 11.5 : 12, lineHeight: desktop ? 17 : 18, color: line().startsWith("import") || line().startsWith("const") ? sys().secondary : sys().label }}>{line() || " "}</Text>}
          </Each>
        </View>
      </If>
      <If when={!tui}>
        <Actions />
      </If>
    </View>
  );
}

/** A dot breathing while the reply has not started. */
function Thinking() {
  return <View class="animate-pulse" style={{ width: tui ? 2 : 10, height: tui ? 1 : 10, marginVertical: tui ? 0 : 5, borderRadius: 5, backgroundColor: sys().label }} />;
}

/** Send: a solid circle once there is something to send, the voice bars
 * before. */
function Send(props: { size: number; ready: boolean; onPress: () => void }) {
  return (
    <View
      onPress={props.onPress}
      activeStyle={{ transform: "scale(0.9)" }}
      style={{ width: props.size, height: props.size, borderRadius: props.size / 2, alignItems: "center", justifyContent: "center", backgroundColor: sys().accent, transitionProperty: "transform", transitionDuration: 160 }}
    >
      <If
        when={props.ready}
        else={
          <View style={{ flexDirection: "row", alignItems: "center", gap: props.size * 0.07 }}>
            <Each of={[0.22, 0.46, 0.3, 0.46, 0.22]}>{(h) => <View style={{ width: props.size * 0.065, height: props.size * h(), borderRadius: 2, backgroundColor: sys().onAccent }} />}</Each>
          </View>
        }
      >
        <Icon name="arrow-up" size={props.size * 0.55} weight={2.4} tint={sys().onAccent} />
      </If>
    </View>
  );
}

/** A round glass toolbar button, as iOS 26's. */
function GlassButton(props: { size: number; width?: number; children: JSX.Element }) {
  return (
    <View activeStyle={{ transform: "scale(0.94)" }} style={{ ...glass(props.size / 2), width: props.width ?? props.size, height: props.size, flexDirection: "row", alignItems: "center", justifyContent: "space-evenly", transitionProperty: "transform", transitionDuration: 160 }}>
      {props.children}
    </View>
  );
}

/** The sidebar mark: two lines, the lower shorter, with a dot for news. */
function SidebarMark() {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
        <View style={{ width: 12, height: 1.8, borderRadius: 0.9, backgroundColor: sys().label }} />
        <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: -5, backgroundColor: "#3b82f6" }} />
      </View>
      <View style={{ width: 8, height: 1.8, borderRadius: 0.9, backgroundColor: sys().label }} />
    </View>
  );
}

function App() {
  const messages = signal<Msg[]>(OPENING);
  const thinking = signal(false);
  const live = signal<string | null>(null);
  const draft = signal("");
  let ids = OPENING.length;
  let scroller: ScrollRef | undefined;
  let busy = false;
  const end = () => setTimeout(() => scroller?.scrollToEnd({ animated: true }), 16);

  /** Thinks a moment, then streams `text` a few characters a frame. */
  const reply = async (text: string) => {
    thinking.set(true);
    end();
    await sleep(900);
    thinking.set(false);
    for (let n = 0; n <= text.length; n += 3) {
      live.set(text.slice(0, n));
      if (n % 30 === 0) end();
      await sleep(22);
    }
    live.set(null);
    messages.set([...messages(), { id: ids++, from: "assistant", text }]);
    end();
  };
  const ask = async (text: string, answer: string) => {
    if (busy || !text.trim()) return;
    busy = true;
    messages.set([...messages(), { id: ids++, from: "user", text: text.trim() }]);
    await reply(answer);
    busy = false;
  };
  const send = () => {
    const text = draft();
    draft.set("");
    void ask(text, SCRIPTED);
  };
  // The thread opens at its end, under the toolbar, and the exchange plays.
  setTimeout(() => scroller?.scrollToEnd({ animated: false }), 0);
  setTimeout(() => void ask(FOLLOW_UP, GLASS), 1400);

  const thread = (pad: { top: number; bottom: number; side: number }) => (
    <Scroll ref={(r: ScrollRef) => (scroller = r)} style={{ flex: 1 }}>
      <View style={{ paddingTop: pad.top, paddingBottom: pad.bottom, paddingHorizontal: pad.side, gap: tui ? 1 : desktop ? 18 : 20 }}>
        <Each of={messages()} key={(m) => m.id}>
          {(msg) => (msg().id < OPENING.length ? <Message msg={msg()} /> : <Rise><Message msg={msg()} /></Rise>)}
        </Each>
        <If when={thinking()}>
          <Rise><Thinking /></Rise>
        </If>
        <If when={live() !== null}>
          <Rich text={live() ?? ""} />
        </If>
      </View>
    </Scroll>
  );
  const input = (height: number) => (
    <Input
      value={draft()}
      onChange={({ value }) => draft.set(value)}
      onSubmit={send}
      placeholder="Ask anything"
      style={{ flex: 1, height, fontSize: desktop ? 13 : 15, color: sys().label, placeholderColor: sys().tertiary, selectionColor: sys().link }}
    />
  );
  /** The page's own color fading out over the thread, under a toolbar. */
  const fade = (edge: "top" | "bottom", height: number) => {
    const clear = sys().dark ? "rgba(0,0,0,0)" : "rgba(255,255,255,0)";
    const solid = <View style={{ height: height * 0.45, backgroundColor: sys().background }} />;
    const ramp = <View style={{ flex: 1, backgroundImage: `linear-gradient(${edge === "top" ? "180deg" : "0deg"}, ${sys().background}, ${clear})` }} />;
    return (
      <View style={{ position: "absolute", top: edge === "top" ? 0 : undefined, bottom: edge === "bottom" ? 0 : undefined, left: 0, right: 0, height, pointerEvents: "none", flexDirection: edge === "top" ? "column" : "column-reverse" }}>
        {solid}
        {ramp}
      </View>
    );
  };

  if (tui) {
    // A terminal: whole cells, a rule beside the list, a prompt box.
    return (
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ width: 176, borderRightWidth: 1, borderColor: sys().line }}>
          <Text style={{ fontWeight: "600", color: sys().label }}>+ New chat</Text>
          <Text style={{ marginTop: 16, color: sys().tertiary }}>Today</Text>
          <Each of={CHATS}>
            {(title, i) => (
              <View style={{ paddingRight: 16, backgroundColor: i() === 0 ? sys().bubble : "transparent" }}>
                <Text style={{ numberOfLines: 1, color: i() === 0 ? sys().label : sys().secondary }}>{title()}</Text>
              </View>
            )}
          </Each>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ paddingHorizontal: 16, fontWeight: "600", color: sys().label }}>{CHATS[0]}</Text>
          {thread({ top: 16, bottom: 0, side: 16 })}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginLeft: 16, borderWidth: 1, borderRadius: 8, borderColor: sys().line, padding: 12 }}>
            <View>
              <Text style={{ color: sys().label }}>›</Text>
            </View>
            {input(16)}
          </View>
        </View>
      </View>
    );
  }

  if (!desktop) {
    // A phone: the thread full screen, scrolling on under glass buttons and
    // the composer; the conversations open from the leading button.
    return (
      <View style={{ flex: 1, backgroundColor: sys().background }}>
        {thread({ top: 60, bottom: 84, side: 16 })}
        {fade("top", 76)}
        {fade("bottom", 60)}
        <View style={{ position: "absolute", top: 10, left: 12, right: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", pointerEvents: "box-none" }}>
          <GlassButton size={36}>
            <SidebarMark />
          </GlassButton>
          <GlassButton size={36} width={72}>
            <Icon name="plus" size={17} weight={1.9} tint={sys().label} />
            <More tint={sys().label} size={3} />
          </GlassButton>
        </View>
        <View style={{ position: "absolute", bottom: 12, left: 12, right: 12 }}>
          <View style={{ ...glass(21), height: 42, flexDirection: "row", alignItems: "center", paddingLeft: 11, paddingRight: 5, gap: 8 }}>
            <Icon name="plus" size={18} weight={1.8} tint={sys().label} />
            {input(34)}
            <Send size={32} ready={draft().trim() !== ""} onPress={send} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: sys().sidebar }}>
      <View style={{ width: 200, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 8, gap: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 26, paddingHorizontal: 8, marginBottom: 8 }}>
          <Icon name="sidebar" size={15} tint={sys().secondary} />
          <Icon name="search" size={14} tint={sys().secondary} />
        </View>
        <View hoverStyle={{ backgroundColor: sys().selection }} style={{ flexDirection: "row", alignItems: "center", gap: 7, height: 28, paddingHorizontal: 8, borderRadius: 7, marginBottom: 10 }}>
          <Icon name="plus" size={13} weight={1.8} tint={sys().label} />
          <Text style={{ fontSize: 13, color: sys().label }}>New chat</Text>
        </View>
        <Text style={{ fontSize: 11, fontWeight: "500", color: sys().tertiary, paddingHorizontal: 8, paddingBottom: 3 }}>Today</Text>
        <Each of={CHATS}>
          {(title, i) => (
            <View hoverStyle={{ backgroundColor: sys().selection }} style={{ height: 28, justifyContent: "center", paddingHorizontal: 8, borderRadius: 7, borderCurve: "continuous", backgroundColor: i() === 0 ? sys().selection : "transparent" }}>
              <Text style={{ numberOfLines: 1, fontSize: 13, color: sys().label }}>{title()}</Text>
            </View>
          )}
        </Each>
      </View>
      {/* The conversation: a panel over the sidebar, the thread scrolling on
          under its title and the glass composer. */}
      <View style={{ flex: 1, minWidth: 0, backgroundColor: sys().background, borderTopLeftRadius: 12, borderBottomLeftRadius: 12, borderCurve: "continuous", overflow: "hidden", boxShadow: sys().dark ? "-2px 0 16px rgba(0,0,0,0.35)" : "-2px 0 16px rgba(0,0,0,0.06)" }}>
        <View style={{ flex: 1, width: "100%", maxWidth: 700, alignSelf: "center" }}>
          {thread({ top: 48, bottom: 76, side: 28 })}
        </View>
        {fade("top", 56)}
        {fade("bottom", 52)}
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 38, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, pointerEvents: "box-none" }}>
          <Text style={{ flex: 1, numberOfLines: 1, fontSize: 13, fontWeight: "600", color: sys().label }}>{CHATS[0]}</Text>
          <More tint={sys().secondary} size={3} />
        </View>
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 14, alignItems: "center", paddingHorizontal: 20, pointerEvents: "box-none" }}>
          <View style={{ ...glass(19), width: "100%", maxWidth: 620, height: 38, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 5 }}>
            <Icon name="plus" size={15} weight={1.8} tint={sys().label} />
            {input(30)}
            <Send size={28} ready={draft().trim() !== ""} onPress={send} />
          </View>
        </View>
      </View>
    </View>
  );
}

mount(App);
