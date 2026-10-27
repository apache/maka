import { batch, computed, effect, List, Scroll, signal, Text, View, type YNode } from "nsh";
import { Input } from "nsh/base";
import { createAnimatedValue, LayoutAnimation } from "nsh";
import { Clipboard } from "nsh";
import { Collapsible } from "nsh/base";
import { keyboardFrame, safeAreaInsets } from "nsh";
import { Icon, type IconName } from "./icons";
import { alpha, Appear, Badge, colors, finish, IconTile, motion, Press, radius, RoundButton, Segmented, toneTint } from "./ui";
import { Glyph } from "./chat/glyphs";
import { Markdown } from "./chat/markdown";
import { ActionButton, Avatar, Caret, DateSeparator, ErrorRow, FileChip, Photo, Spinner, ToolCard } from "./chat/parts";
import { type FileRef, freeform, history, type Model, type Msg, photo, retried, type Scenario, scenarios, type Status, type Tool } from "./chat/scripts";

type Assistant = Extract<Msg, { kind: "assistant" }>;
type User = Extract<Msg, { kind: "user" }>;

const models = [
  { value: "Swift", label: "Swift" },
  { value: "Deep", label: "Deep" },
  { value: "Vision", label: "Vision" },
] as const;

const featured: { id: string; icon: IconName; note: string }[] = [
  { id: "guide", icon: "text", note: "Markdown, a table, code" },
  { id: "reason", icon: "spark", note: "Reasoning first" },
  { id: "search", icon: "search", note: "A tool call" },
  { id: "vision", icon: "image", note: "A photo and a file" },
];

/** Thrown into a run that was stopped. */
class Stopped extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Copied from the gallery (examples/gallery/demos/Chat.tsx) for the
 * website's hero; only the imports and `autoplay` differ.
 *
 * A simulated AI assistant: replies stream token by token (batched per
 * frame), think first, call tools, fail and recover; every scenario comes
 * from local scripts and timers.
 */
export function Chat(props: { autoplay?: string } = {}) {
  const insets = safeAreaInsets();
  let ids = 0;
  const nextId = () => `m${ids++}`;

  const messages = signal<Msg[]>([]);
  const model = signal<Model>("Swift");
  const draft = signal("");
  const inputHeight = signal(20);
  const attachment = signal<{ image: string; file: FileRef } | null>(null);
  const menu = signal(false);
  const banner = signal<"offline" | "online" | null>(null);
  const bannerKind = signal<"offline" | "online">("offline");
  /** The copied message or code block, for a moment. */
  const copied = signal<string | null>(null);

  // The reply being written. Finished replies are plain data in `messages`.
  const liveId = signal<string | null>(null);
  const liveReason = signal("");
  const liveThinking = signal<{ start: number; seconds: number | null } | null>(null);
  const liveTools = signal<Tool[]>([]);
  const liveMd = signal("");
  const now = signal(0);

  /** Whether the user is at the bottom (the list then follows the stream
   * natively, `maintainVisibleContentPosition`); scrolling up clears it. */
  const following = signal(true);
  let list: YNode | undefined;
  let dragging = false;

  type Run = { id: string; model: Model; script: string; cancelled: boolean; md: string; reason: string; thinkStart: number; thinkSeconds: number | null };
  let run: Run | null = null;
  let ticker: number | undefined;

  // Tokens collect here and reach the signals once per frame.
  let pendingText = "";
  let pendingReason = "";
  let frameQueued = false;
  /** Scrolls to the end on the user's own action (send, jump, load). */
  const toEnd = (animated = true) => {
    following.set(true);
    list?.scrollToEnd({ animated });
  };
  const flush = () => {
    frameQueued = false;
    const r = run;
    if (!r) return;
    batch(() => {
      if (pendingReason) {
        r.reason += pendingReason;
        pendingReason = "";
        liveReason.set(r.reason);
      }
      if (pendingText) {
        r.md += pendingText;
        pendingText = "";
        liveMd.set(r.md);
      }
    });
  };
  const queue = () => {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(flush);
  };

  const wait = async (r: Run, ms: number) => {
    await sleep(ms);
    if (r.cancelled) throw new Stopped();
  };
  /** Streams `text` at about `rate` tokens a second, with jitter. */
  const stream = async (r: Run, text: string, rate: number, into: "text" | "reason") => {
    for (const token of text.match(/\s*\S{1,4}|\s+/g) ?? []) {
      await wait(r, (1000 / rate) * (0.55 + Math.random() * 0.9));
      if (into === "text") pendingText += token;
      else pendingReason += token;
      queue();
    }
    flush();
  };
  const setTool = (id: string, change: Partial<Tool>) => liveTools.set(liveTools().map((t) => (t.id === id ? ({ ...t, ...change } as Tool) : t)));

  const stopTicker = () => {
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
  };

  /** Freezes the reply into a message and ends the run. */
  const freeze = (r: Run, status: Status, error?: string) => {
    if (run !== r) return;
    r.md += pendingText;
    r.reason += pendingReason;
    pendingText = pendingReason = "";
    stopTicker();
    const seconds = r.thinkSeconds ?? Math.max(1, Math.round((performance.now() - r.thinkStart) / 1000));
    const final: Assistant = {
      kind: "assistant",
      id: r.id,
      model: r.model,
      script: r.script,
      reasoning: r.reason ? { text: r.reason, seconds, open: false } : undefined,
      tools: liveTools().map((t) => (t.state === "done" ? t : ({ ...t, state: "cancelled" } as Tool))),
      md: r.md,
      status,
      error,
    };
    run = null;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    batch(() => {
      messages.set(messages().map((m) => (m.id === r.id ? final : m)));
      liveId.set(null);
    });
    // The list follows the final layout natively; once the layout animation
    // has settled, make sure a following list ends exactly at the bottom.
    setTimeout(() => following() && list?.scrollToEnd({ animated: true }), 360);
  };

  /** Runs a scenario's reply; `at` replaces that message (retry, regenerate). */
  const reply = async (s: Scenario, at?: string) => {
    const r: Run = { id: nextId(), model: s.model, script: s.id, cancelled: false, md: "", reason: "", thinkStart: performance.now(), thinkSeconds: null };
    run = r;
    const placeholder: Assistant = { kind: "assistant", id: r.id, model: s.model, script: s.id, tools: [], md: "", status: "done" };
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    batch(() => {
      liveReason.set("");
      liveThinking.set(null);
      liveTools.set([]);
      liveMd.set("");
      liveId.set(r.id);
      messages.set(at ? messages().map((m) => (m.id === at ? placeholder : m)) : [...messages(), placeholder]);
    });
    try {
      await wait(r, 450);
      for (const step of s.steps) {
        if ("think" in step) {
          r.thinkStart = performance.now();
          now.set(r.thinkStart);
          liveThinking.set({ start: r.thinkStart, seconds: null });
          ticker = setInterval(() => now.set(performance.now()), 1000);
          await stream(r, step.think, 75, "reason");
          stopTicker();
          r.thinkSeconds = Math.max(1, Math.round((performance.now() - r.thinkStart) / 1000));
          liveThinking.set({ start: r.thinkStart, seconds: r.thinkSeconds });
          await wait(r, 350);
        } else if ("tool" in step) {
          liveTools.set([...liveTools(), { ...step.tool, state: "pending" }]);
          await wait(r, 450);
          setTool(step.tool.id, { state: "running" });
          await wait(r, step.ms);
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setTool(step.tool.id, { state: "done" });
          await wait(r, 400);
        } else if ("say" in step) {
          await stream(r, step.say, 40, "text");
        } else if ("fail" in step) {
          await wait(r, 900);
          freeze(r, "error", step.fail);
          return;
        }
      }
      freeze(r, "done");
    } catch (e) {
      // A stopped run was frozen by `stop` already.
      if (!(e instanceof Stopped)) throw e;
    }
  };

  const stop = () => {
    if (!run) return;
    run.cancelled = true;
    freeze(run, "stopped");
  };

  const jumpToLatest = () => {
    toEnd();
  };

  /** Sends the user's message for a scenario, then its reply. */
  const submit = async (s: Scenario, text: string, image?: string, file?: FileRef) => {
    if (run) return;
    menu.set(false);
    following.set(true);
    const offline = s.steps.find((step) => "offline" in step) as { offline: number } | undefined;
    const user: User = { kind: "user", id: nextId(), text, image, file, waiting: !!offline };
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    batch(() => {
      const start: Msg[] = messages().length ? [] : [{ kind: "date", id: nextId(), label: "Today" }];
      messages.set([...messages(), ...start, user]);
      draft.set("");
      attachment.set(null);
      model.set(s.model);
    });
    toEnd();
    if (offline) {
      bannerKind.set("offline");
      banner.set("offline");
      await sleep(offline.offline);
      bannerKind.set("online");
      messages.set(messages().map((m) => (m.id === user.id ? { ...user, waiting: false } : m)));
      await sleep(900);
      banner.set(null);
    }
    void reply({ ...s, steps: s.steps.filter((step) => !("offline" in step)) });
  };

  const send = () => {
    const text = draft().trim();
    const a = attachment();
    if (!text && !a) return;
    if (a) {
      const vision = scenarios.find((s) => s.id === "vision")!;
      void submit({ ...vision, model: model() === "Swift" ? "Vision" : model() }, text || vision.prompt, a.image, a.file);
    } else void submit(freeform(text, model()), text);
  };

  const play = (id: string) => {
    if (id === "history") {
      menu.set(false);
      messages.set([...history(nextId), ...messages()]);
      toEnd(false);
      return;
    }
    const s = scenarios.find((x) => x.id === id)!;
    void submit(s, s.prompt, s.image, s.file);
  };

  const update = (id: string, change: (m: Assistant) => Assistant) =>
    messages.set(messages().map((m) => (m.id === id && m.kind === "assistant" ? change(m) : m)));

  const promptBefore = (id: string) => {
    const all = messages();
    for (let i = all.findIndex((m) => m.id === id) - 1; i >= 0; i--) {
      const m = all[i];
      if (m.kind === "user") return m.text;
    }
    return "";
  };
  const regenerate = (m: Assistant) => {
    if (run) return;
    following.set(true);
    const s = m.script === "retry" ? retried : scenarios.find((x) => x.id === m.script) ?? freeform(promptBefore(m.id), m.model);
    void reply({ ...s, model: m.model, steps: s.steps.filter((step) => !("offline" in step || "fail" in step)) }, m.id);
  };
  const retry = (m: Assistant) => {
    if (run) return;
    following.set(true);
    void reply(retried, m.id);
  };
  const copy = (key: string, text: string) => {
    Clipboard.writeText(text);
    copied.set(key);
    setTimeout(() => copied() === key && copied.set(null), 1600);
  };

  // Motion, run natively when the state changes.
  const jump = createAnimatedValue(0);
  effect(() => void jump.spring(following() ? 0 : 1, motion.settle));
  const menuValue = createAnimatedValue(0);
  effect(() => void menuValue.spring(menu() ? 1 : 0, motion.settle));
  const bannerValue = createAnimatedValue(0);
  effect(() => void bannerValue.spring(banner() ? 1 : 0, motion.settle));

  const streaming = () => liveId() !== null;
  const canSend = () => !!draft().trim() || !!attachment();

  const userRow = (m: () => User) => (
    <View style={{ alignItems: "flex-end", paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
      <If when={m().image}>
        <Photo src={m().image!} width={220} height={165} />
      </If>
      <If when={m().file}>
        <FileChip file={m().file!} />
      </If>
      <If when={m().text}>
        <View
          style={{
            maxWidth: "82%",
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 20,
            borderBottomRightRadius: 6,
            borderCurve: "continuous",
            // A message is read, not pressed: flat, a hairline around it.
            backgroundColor: colors.raised,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text selectable style={{ fontSize: 15, lineHeight: 21, color: colors.text }}>{m().text}</Text>
        </View>
      </If>
      <If when={m().waiting}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Spinner size={12} tint={colors.warn} />
          <Text style={{ fontSize: 12, color: colors.muted }}>Waiting for a connection</Text>
        </View>
      </If>
    </View>
  );

  const assistantRow = (m: () => Assistant) => {
    const live = () => liveId() === m().id;
    const reasoning = () => (live() ? (liveReason() ? { text: liveReason(), open: true } : null) : m().reasoning ?? null);
    const thinkingLabel = () => {
      if (live()) {
        const t = liveThinking();
        if (t && t.seconds === null) return `Thinking… ${Math.max(0, Math.floor((now() - t.start) / 1000))} s`;
        return `Thought for ${t?.seconds ?? 1} s`;
      }
      return `Thought for ${m().reasoning?.seconds ?? 1} s`;
    };
    const tools = () => (live() ? liveTools() : m().tools);
    const md = () => (live() ? liveMd() : m().md);
    const waitingForWords = () => live() && !liveMd() && !liveTools().length && !(liveThinking() && liveThinking()!.seconds === null);
    return (
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 26 }}>
          <Avatar />
          <Text style={{ flex: 1, fontSize: 13, fontWeight: "600", color: colors.muted }}>{m().model}</Text>
          <If when={!live() && m().status === "stopped"}>
            <Badge label="Stopped" tone="warn" />
          </If>
        </View>
        <If when={reasoning()}>
          <Collapsible
            open={!!reasoning()?.open}
            class="gap-2"
            content={
              <View style={{ flexDirection: "row", gap: 12, paddingLeft: 7 }}>
                <View style={{ width: 2, borderRadius: 1, backgroundColor: colors.border }} />
                <Text selectable style={{ flex: 1, fontSize: 14, lineHeight: 20, color: colors.muted }}>{reasoning()?.text}</Text>
              </View>
            }
          >
            <Press
              scale={0.98}
              onPress={() => {
                if (live()) return;
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                update(m().id, (x) => ({ ...x, reasoning: x.reasoning && { ...x.reasoning, open: !x.reasoning.open } }));
              }}
              accessibilityLabel="Reasoning"
              accessibilityState={{ expanded: !!reasoning()?.open }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 32, alignSelf: "flex-start" }}>
                <If when={live() && liveThinking()?.seconds === null} else={<Glyph name="brain" size={16} tint={colors.muted} />}>
                  <Spinner size={14} tint={colors.muted} />
                </If>
                <Text style={{ fontSize: 14, color: colors.muted, fontVariant: ["tabular-nums"] }}>{thinkingLabel()}</Text>
                <View
                  style={{
                    transform: [{ rotate: reasoning()?.open ? "0deg" : "-90deg" }],
                    transitionProperty: "transform",
                    transitionDuration: 220,
                    transitionTimingFunction: "ease-out",
                  }}
                >
                  <Glyph name="caret-down" size={14} tint={colors.faint} />
                </View>
              </View>
            </Press>
          </Collapsible>
        </If>
        <Each of={tools()} key={(t) => t.id}>
          {(tool) => <ToolCard tool={tool()} />}
        </Each>
        <If when={waitingForWords()}>
          <View style={{ flexDirection: "row", height: 22, alignItems: "center" }}>
            <Caret />
          </View>
        </If>
        <Markdown md={md()} id={m().id} streaming={live()} caret={live() ? <Caret /> : undefined} />
        <If when={!live() && m().status === "error"}>
          <ErrorRow message={m().error ?? "Something went wrong."} onRetry={() => retry(m())} />
        </If>
        <If when={!live() && m().status === "stopped"}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Glyph name="stop" size={12} tint={colors.faint} />
            <Text style={{ fontSize: 13, color: colors.faint }}>You stopped this reply</Text>
          </View>
        </If>
        <If when={!live() && m().status !== "error"}>
          <View style={{ flexDirection: "row", alignItems: "center", marginLeft: -8, marginTop: -6 }}>
            <ActionButton glyph={copied() === m().id ? "check" : "copy"} label="Copy" active={copied() === m().id} tone="up" onPress={() => copy(m().id, m().md)} />
            <ActionButton glyph="regenerate" label="Regenerate" onPress={() => regenerate(m())} />
            <ActionButton
              glyph="thumb-up"
              label="Good reply"
              active={m().rating === "up"}
              onPress={() => update(m().id, (x) => ({ ...x, rating: x.rating === "up" ? undefined : "up" }))}
            />
            <ActionButton
              glyph="thumb-down"
              label="Bad reply"
              active={m().rating === "down"}
              tone="danger"
              onPress={() => update(m().id, (x) => ({ ...x, rating: x.rating === "down" ? undefined : "down" }))}
            />
          </View>
        </If>
      </View>
    );
  };

  const empty = (
    <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 16, paddingVertical: 24, gap: 24 }}>
        <Appear>
          <View style={{ alignItems: "center", gap: 12 }}>
            <IconTile name="spark" tint={colors.accent} size={56} />
            <Text style={{ fontSize: 22, fontWeight: "600", color: colors.text }}>How can I help?</Text>
            <Text style={{ fontSize: 15, lineHeight: 21, color: colors.muted, textAlign: "center" }}>
              A simulated assistant: every reply is scripted and streamed locally.
            </Text>
          </View>
        </Appear>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          <Each of={featured}>
            {(f, i) => {
              const s = scenarios.find((x) => x.id === f().id)!;
              return (
                <View style={{ width: "47%", flexGrow: 1 }}>
                  <Appear index={i() + 1}>
                    <Press onPress={() => play(s.id)} accessibilityLabel={s.chip}>
                      <View
                        style={{
                          minHeight: 104,
                          padding: 12,
                          gap: 8,
                          borderRadius: radius.inset,
                          borderCurve: "continuous",
                          backgroundColor: colors.surface,
                          ...finish.card,
                          borderWidth: 1,
                          borderColor: colors.border,
                        }}
                      >
                        <Icon name={f().icon} size={18} tint={colors.accent} />
                        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{s.chip}</Text>
                        <Text style={{ fontSize: 12, color: colors.muted }}>{f().note}</Text>
                      </View>
                    </Press>
                  </Appear>
                </View>
              );
            }}
          </Each>
        </View>
    </View>
  );

  // The website's hero plays one scenario on its own, then stays interactive.
  if (props.autoplay) {
    const id = props.autoplay;
    setTimeout(() => play(id), 900);
  }

  const chips = [...scenarios.map((s) => ({ id: s.id, label: s.chip })), { id: "history", label: "Load a long conversation" }];

  const menuRows: { id: string; glyph: "clip" | "regenerate"; label: string }[] = [
    { id: "attach", glyph: "clip", label: "Attach a photo and a file" },
    ...chips.map((c) => ({ id: c.id, glyph: "regenerate" as const, label: c.label })),
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ flex: 1, paddingBottom: "env(keyboard-inset-height)" }}>
        <View style={{ flex: 1 }}>
          <If when={messages().length} else={empty}>
            {/* One selection across messages: in the List, over the rows that are mounted. */}
            <View selectable style={{ flex: 1 }}>
              <List
                ref={list}
                each={messages()}
                keyExtractor={(m) => m.id}
                estimatedItemSize={140}
                initialScrollIndex={Math.max(0, messages().length - 1)}
                style={{ flex: 1 }}
                contentStyle={{ paddingTop: 8, paddingBottom: 16 }}
                keyboardDismissMode="interactive"
                maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 40 }}
                scrollEventThrottle={100}
                onScrollDragStart={() => (dragging = true)}
                onScroll={(e) => {
                  if (dragging) following.set(e.offset.y + e.size.height >= e.contentSize.height - 40);
                }}
                onMomentumEnd={() => (dragging = false)}
                onScrollEnd={() => (dragging = false)}
              >
                {(item) => {
                  const kind = computed(() => item().kind);
                  return (
                    <View>
                      {(() => {
                        switch (kind()) {
                          case "date":
                            return <DateSeparator label={(item() as Extract<Msg, { kind: "date" }>).label} />;
                          case "user":
                            return userRow(item as () => User);
                          case "assistant":
                            return assistantRow(item as () => Assistant);
                        }
                      })()}
                    </View>
                  );
                }}
              </List>
            </View>
          </If>

          {/* Jump to the latest message: shown while scrolled up. */}
          <View
            pointerEvents={following() ? "none" : "auto"}
            style={{
              position: "absolute",
              right: 16,
              bottom: 12,
              opacity: jump,
              transform: [{ scale: jump.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }],
            }}
          >
            <RoundButton icon="arrow-down" label="Jump to the latest message" variant="secondary" onPress={jumpToLatest} />
            <If when={streaming()}>
              <View style={{ position: "absolute", top: 2, right: 2, width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.background }} />
            </If>
          </View>

          {/* Connection banner. */}
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 8,
              left: 16,
              right: 16,
              opacity: bannerValue,
              transform: [{ translateY: bannerValue.interpolate({ inputRange: [0, 1], outputRange: [-64, 0] }) }],
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: 48,
                paddingHorizontal: 14,
                borderRadius: radius.inset,
                borderCurve: "continuous",
                ...finish.menu,
                borderWidth: 1,
                borderColor: alpha(bannerKind() === "offline" ? colors.warn : colors.up, 0.35),
              }}
            >
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: toneTint(bannerKind() === "offline" ? "warn" : "up"),
                }}
              >
                <Glyph name={bannerKind() === "offline" ? "offline" : "check"} size={15} tint={bannerKind() === "offline" ? colors.warn : colors.up} />
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{bannerKind() === "offline" ? "You're offline" : "Back online"}</Text>
                <Text style={{ fontSize: 13, color: colors.muted }}>
                  {bannerKind() === "offline" ? "Your message sends when the connection returns." : "Sending your message."}
                </Text>
              </View>
            </View>
          </View>

          {/* The "+" menu: attachments and the scenarios, to replay them. */}
          <View
            pointerEvents={menu() ? "auto" : "none"}
            onPress={() => menu.set(false)}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.45)", opacity: menuValue }}
          />
          <View
            pointerEvents={menu() ? "auto" : "none"}
            style={{
              position: "absolute",
              left: 16,
              right: 16,
              bottom: 8,
              opacity: menuValue,
              transform: [
                { translateY: menuValue.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
                { scale: menuValue.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
              ],
            }}
          >
            <View
              style={{
                borderRadius: radius.card,
                borderCurve: "continuous",
                ...finish.menu,
                borderWidth: 1,
                paddingVertical: 6,
                maxHeight: 460,
                overflow: "hidden",
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: colors.faint, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>ADD AND REPLAY</Text>
              <Scroll style={{ flexGrow: 0 }}>
                <Each of={menuRows}>
                  {(row, i) => (
                    <View
                      onPress={() => {
                        menu.set(false);
                        if (row().id === "attach") attachment.set({ image: photo, file: { name: "trip-notes.pdf", size: "2.4 MB" } });
                        else play(row().id);
                      }}
                      activeStyle={{ backgroundColor: alpha(colors.text, 0.06) }}
                      role="button"
                      accessibilityLabel={row().label}
                      style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 48, paddingHorizontal: 16 }}
                    >
                      <Glyph name={row().glyph} size={16} tint={i() === 0 ? colors.accent : colors.muted} />
                      <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>{row().label}</Text>
                    </View>
                  )}
                </Each>
              </Scroll>
            </View>
          </View>
        </View>

        {/* Suggestions while the conversation is empty. */}
        <If when={!messages().length}>
          <Scroll horizontal scrollbar={false} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }}>
            <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
              <Each of={chips}>
                {(chip) => (
                  <Press onPress={() => play(chip().id)} hitSlop={4} accessibilityLabel={chip().label}>
                    <View
                      style={{
                        height: 36,
                        paddingHorizontal: 14,
                        borderRadius: 18,
                        justifyContent: "center",
                        ...finish.pill,
                        borderWidth: 1,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: "500", color: colors.text }}>{chip().label}</Text>
                    </View>
                  </Press>
                )}
              </Each>
            </View>
          </Scroll>
        </If>

        {/* The composer. */}
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 + (keyboardFrame().height > 0 ? 0 : insets().bottom), gap: 8 }}>
          <If when={attachment()}>
            <Appear>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Photo src={attachment()!.image} width={48} height={48} />
                <View style={{ flex: 1 }}>
                  <FileChip file={attachment()!.file} onRemove={() => attachment.set(null)} />
                </View>
              </View>
            </Appear>
          </If>
          <View
            style={{
              borderRadius: 24,
              borderCurve: "continuous",
              // Glass like the menu above it, without the blur: nothing scrolls under it.
              ...finish.menu,
              backdropFilter: undefined,
              borderWidth: 1,
              padding: 6,
              gap: 4,
            }}
          >
            <Input
              value={draft()}
              onChange={(v) => draft.set(v)}
              multiline
              placeholder={`Message ${model()}`}
              onFocus={() => menu.set(false)}
              onContentSizeChange={(e) => inputHeight.set(Math.min(100, Math.max(20, e.height)))}
              style={{ height: inputHeight() + 20, fontSize: 15, lineHeight: 20, color: colors.text, placeholderColor: colors.faint, selectionColor: colors.accent, paddingHorizontal: 10, paddingVertical: 10 }}
            />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View
                style={{
                  transform: [{ rotate: menu() ? "45deg" : "0deg" }],
                  transitionProperty: "transform",
                  transitionDuration: 200,
                  transitionTimingFunction: "ease-out",
                }}
              >
                <RoundButton icon="plus" label="Add" variant="secondary" onPress={() => menu.set(!menu())} />
              </View>
              <View style={{ flex: 1 }}>
                <Segmented size="small" options={models} value={model()} onChange={(v) => model.set(v)} />
              </View>
              <If
                when={streaming()}
                else={
                  <View style={{ opacity: canSend() ? 1 : 0.35 }} pointerEvents={canSend() ? "auto" : "none"}>
                    <RoundButton icon="arrow-up" label="Send" onPress={send} />
                  </View>
                }
              >
                <Press onPress={stop} scale={0.9} accessibilityLabel="Stop generating">
                  <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: colors.light, ...finish.light }}>
                    <Glyph name="stop" size={16} tint={colors.onLight} />
                  </View>
                </Press>
              </If>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
