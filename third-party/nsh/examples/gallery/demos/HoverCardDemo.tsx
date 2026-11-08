import { type JSX, platform, signal, Text, View } from "nsh";
import { HoverCard, type OpenChangeReason } from "nsh/base";
import { LucideIcon, type LucideIconName } from "../icons";
import { alpha, Badge, Button, Caption, colors, Card, DemoPage, finish, focusRing, hint, mono, PopIn, popoverLook, type PopupSide, Segmented, Stat, terminal, Toggle, toneColor } from "../ui";
import { Avatar, createEvents } from "./OverlayUi";

// A trigger is a view with the link role and its own `onPress`: the card's
// listeners join the app's on that element (a Rust component such as
// `Link` keeps its own presses and focus, so it opens the card on hover
// only). `nsh/base`'s `HoverCard` follows the pointer and its delays natively and
// draws nothing; the gallery's look is `PopIn`'s surface coming out of the
// trigger's edge, and the popup's box fading out on its way (its ending
// class, which it keeps while the 150 ms transition runs). With reduced
// motion both stand still.

const pointer = platform.idiom === "desktop";
const exit = {
  popupClass: "transition-opacity duration-150 ease-in motion-reduce:transition-none",
  popupEndingClass: "opacity-0",
};
const small = pointer ? 12 : 13;
const body = pointer ? 13 : 15;

type Person = {
  handle: string;
  name: string;
  role: string;
  bio: string;
  city: string;
  time: string;
  projects: string;
  reviews: string;
  followers: number;
  away?: boolean;
};

const people: Record<string, Person> = {
  mira: { handle: "mira", name: "Mira Chen", role: "Design lead · Platform", bio: "Shapes the components teams build on. Ask about motion and type.", city: "Shanghai", time: "16:42", projects: "12", reviews: "248", followers: 1204 },
  ravi: { handle: "ravi", name: "Ravi Patel", role: "Staff engineer · Runtime", bio: "Keeps the engine thread under a millisecond, and writes the benchmarks that say so.", city: "Bengaluru", time: "14:12", projects: "31", reviews: "1,092", followers: 3870 },
  lena: { handle: "lena", name: "Lena Okafor", role: "Product manager · Trading", bio: "Owns the order ticket and everything that can go wrong in it.", city: "Lagos", time: "09:42", projects: "7", reviews: "96", followers: 512, away: true },
};

type Site = { href: string; domain: string; title: string; summary: string; icon: LucideIconName; read: string };

const sites: Record<string, Site> = {
  taffy: { href: "https://github.com/DioxusLabs/taffy", domain: "github.com", title: "taffy: a flexbox, grid and block layout library", summary: "A high-performance UI layout library written in Rust, with CSS Block, Flexbox and Grid.", icon: "code", read: "2.3k stars" },
  quickjs: { href: "https://bellard.org/quickjs/", domain: "bellard.org", title: "QuickJS JavaScript Engine", summary: "A small and embeddable JavaScript engine supporting the ES2023 specification.", icon: "globe", read: "Fabrice Bellard" },
  wgsl: { href: "https://www.w3.org/TR/WGSL/", domain: "w3.org", title: "WebGPU Shading Language", summary: "The shader language of WebGPU: types, expressions, statements and the built-in functions.", icon: "scroll-text", read: "W3C Draft" },
};

type Quote = { symbol: string; name: string; price: number; open: number; volume: string; cap: string; pe: string };

const quotes: Record<string, Quote> = {
  AAPL: { symbol: "AAPL", name: "Apple Inc.", price: 227.52, open: 224.1, volume: "48.2M", cap: "3.46T", pe: "34.6" },
  NVDA: { symbol: "NVDA", name: "NVIDIA Corp.", price: 138.85, open: 141.97, volume: "212.7M", cap: "3.41T", pe: "65.2" },
  TSLA: { symbol: "TSLA", name: "Tesla, Inc.", price: 251.44, open: 245.3, volume: "96.4M", cap: "803B", pe: "70.1" },
};

/** `n` with a comma between each three digits. */
const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** How a quote moves tick after tick, a fraction of a mille of its price:
 * the same steps each time, so a test can follow them. */
const steps = [0.6, -0.3, 0.9, -0.5, 0.2, -0.8, 0.4, 0.7, -0.2, -0.6];

/** A walk of `n` closes ending at `last`, the same for one symbol each time. */
function history(symbol: string, open: number, last: number, n = 28): number[] {
  let seed = [...symbol].reduce((s, c) => s * 31 + c.charCodeAt(0), 7);
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const out = [open];
  for (let i = 1; i < n - 1; i++) out.push(out[i - 1] + rand() * open * 0.012 + ((last - open) / n) * 0.9);
  out.push(last);
  return out;
}

/**
 * Hover cards as an app has them: people behind the mentions of a thread,
 * the page behind a link, a live quote behind a ticker, the delays tried,
 * and a card the app pins open. The pointer resting on a trigger opens one
 * (or the keyboard focus on it); on a phone a tap does.
 */
export function HoverCardDemo() {
  const { log, Events } = createEvents(hint("Tap a mention, a link or a ticker", "Rest the pointer on a mention, a link or a ticker"));
  const changed = (name: string) => ({ open, reason }: { open: boolean; reason: OpenChangeReason }) => log(`${name} ${open ? "opened" : "closed"} · ${reason}`);

  /** A person's mention: a link to their page, with their card. */
  function Mention(props: { person: Person; side?: PopupSide }) {
    const following = signal(false);
    const side = () => props.side ?? "bottom";
    const p = props.person;
    return (
      <HoverCard {...exit} placement={side()} align="start" offset={6} margin={8} onOpenChange={changed(`@${p.handle}`)} trigger={
        <View
          testID={`mention-${p.handle}`}
          role="link"
          onPress={() => log(`onPress /people/${p.handle}`)}
          hoverStyle={{ backgroundColor: alpha(colors.accent, 0.12) }}
          focusStyle={focusRing(1)}
          style={{ borderRadius: 4, paddingHorizontal: 2, marginHorizontal: -3, borderWidth: 1, borderColor: "transparent", transitionProperty: "background-color", transitionDuration: 120 }}
        >
          <Text style={{ fontSize: body, fontWeight: "500", color: colors.accent }}>@{p.name}</Text>
        </View>
      }>
        <PopIn side={side()} style={popoverLook({ width: pointer ? 280 : 300 })}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View>
              <Avatar name={p.name} size={44} />
              <View style={{ position: "absolute", right: -1, bottom: -1, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: colors.surface, backgroundColor: p.away ? colors.warn : colors.up }} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: pointer ? 15 : 17, fontWeight: "600", color: colors.text }}>{p.name}</Text>
              <Text style={{ fontSize: small, color: colors.muted }}>{p.role}</Text>
            </View>
            <If when={following()}>
              <Badge label="Following" tone="accent" />
            </If>
          </View>
          <Text style={{ fontSize: body, lineHeight: pointer ? 18 : 21, color: colors.text }}>{p.bio}</Text>
          <View style={{ flexDirection: "row", gap: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <LucideIcon name="map-pin" size={13} tint={colors.faint} />
              <Text style={{ fontSize: 12, color: colors.muted }}>{p.city}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <LucideIcon name="clock" size={13} tint={colors.faint} />
              <Text style={{ fontSize: 12, color: colors.muted }}>{p.away ? `Away · ${p.time} local` : `${p.time} local time`}</Text>
            </View>
          </View>
          <View style={{ flexDirection: "row" }}>
            <Stat label="Projects" value={p.projects} width="33%" />
            <Stat label="Reviews" value={p.reviews} width="33%" />
            <Stat label="Followers" value={grouped(p.followers + (following() ? 1 : 0))} width="33%" />
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              flex={1}
              label={following() ? "Following" : "Follow"}
              icon={following() ? "check" : "plus"}
              variant={following() ? "secondary" : "primary"}
              onPress={() => {
                following.set(!following());
                log(`${following() ? "followed" : "unfollowed"} ${p.name}`);
              }}
            />
            <Button flex={1} label="Message" variant="secondary" onPress={() => log(`message to ${p.name}`)} />
          </View>
        </PopIn>
      </HoverCard>
    );
  }

  function Comment(props: { author: string; when: string; children: JSX.Element }) {
    return (
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Avatar name={props.author} size={pointer ? 26 : 32} />
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
            <Text style={{ fontSize: body, fontWeight: "600", color: colors.text }}>{props.author}</Text>
            <Text style={{ fontSize: 11.5, color: colors.faint }}>{props.when}</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 4, rowGap: 2 }}>{props.children}</View>
        </View>
      </View>
    );
  }

  // Running text in a wrapping row: one piece per word, so a line breaks
  // between words, and the row's gap is the space between them. A
  // mention's highlight reaches into that gap (its negative margin), and a
  // link keeps the punctuation after it (`attached`).
  const words = (s: string) => s.split(" ").map((w) => <Text style={{ fontSize: body, color: colors.text }}>{w}</Text>);
  const attached = (link: JSX.Element, after: string) => (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {link}
      <Text style={{ fontSize: body, color: colors.text }}>{after}</Text>
    </View>
  );

  function Thread() {
    return (
      <Card icon="popover" title="Mentions in a thread" subtitle={hint("Tap a name: who it is, and what to do next", "Rest on a name, then move into the card: it stays")}>
        <View style={{ gap: 14 }}>
          <Comment author="Floyd Wang" when="10 min">
            {words("Motion review is tomorrow,")}
            <Mention person={people.mira} />
            {words("has the specs.")}
          </Comment>
          <Comment author="Mira Chen" when="6 min">
            {words("Thanks! Frame budget looks fine per")}
            <Mention person={people.ravi} />
            {words("— ship it.")}
          </Comment>
          <Comment author="Ravi Patel" when="just now">
            <Mention person={people.lena} side="top" />
            {words("the order ticket uses the same card.")}
          </Comment>
        </View>
        <Caption label={hint("A tap outside closes it", "The pointer away from both for 300 ms closes it; Escape at once")} />
      </Card>
    );
  }

  /** A link to a page, with a preview of the page. */
  function Preview(props: { site: Site; label: string }) {
    const s = props.site;
    return (
      <HoverCard {...exit} placement="top" offset={8} margin={8} openDelay={400} onOpenChange={changed(s.domain)} trigger={
        <View
          role="link"
          onPress={() => log(`onPress ${s.href}`)}
          hoverStyle={{ borderBottomColor: colors.accent }}
          focusStyle={focusRing(1)}
          style={{ borderBottomWidth: 1, borderBottomColor: alpha(colors.accent, 0.35), transitionProperty: "border-color", transitionDuration: 150 }}
        >
          <Text style={{ fontSize: body, color: colors.accent }}>{props.label}</Text>
        </View>
      }>
        <PopIn side="top" style={popoverLook({ width: pointer ? 300 : 310 })}>
          {/* The site: its mark on a raised tile, its domain and what it is, the
              link's way out at the end; then the page's title and summary. */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ width: 32, height: 32, borderRadius: 8, borderCurve: "continuous", borderWidth: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.raised, ...finish.raised }}>
              <LucideIcon name={s.icon} size={16} tint={colors.text} />
            </View>
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={{ fontSize: small, fontWeight: "500", color: colors.text }}>{s.domain}</Text>
              <Text style={{ fontSize: 11.5, color: colors.faint }}>{s.read}</Text>
            </View>
            <LucideIcon name="external-link" size={13} tint={colors.faint} />
          </View>
          <View style={{ gap: 4 }}>
            <Text style={{ fontSize: body, fontWeight: "600", color: colors.text }}>{s.title}</Text>
            <Text style={{ fontSize: small, lineHeight: pointer ? 17 : 19, color: colors.muted }}>{s.summary}</Text>
          </View>
        </PopIn>
      </HoverCard>
    );
  }

  function Links() {
    return (
      <Card icon="link" title="A link preview" subtitle="The page behind a link, before going there: the link still opens on a press">
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 4, rowGap: 4 }}>
          {words("Layout runs on")}
          {attached(<Preview site={sites.taffy} label="Taffy" />, ",")}
          {words("scripts on")}
          <Preview site={sites.quickjs} label="QuickJS" />
          {words("and shaders are written in")}
          {attached(<Preview site={sites.wgsl} label="WGSL" />, ".")}
        </View>
        <Caption label="Opened after 400 ms here, above the link" />
      </Card>
    );
  }

  /** A ticker, with a quote that moves while its card is open. */
  function Ticker(props: { quote: Quote }) {
    const q = props.quote;
    const price = signal(q.price);
    const closes = signal(history(q.symbol, q.open, q.price));
    const flash = signal<"up" | "down" | null>(null);
    let timer: ReturnType<typeof setInterval> | undefined;
    let step = 0;
    const change = () => price() - q.open;
    const tone = () => (change() >= 0 ? "up" : "down");
    // Ticks while the card is open, from `onOpen` to `onClose`.
    const tick = () => {
      const next = Math.max(1, price() + steps[step++ % steps.length] * q.price * 0.001);
      flash.set(next >= price() ? "up" : "down");
      price.set(Math.round(next * 100) / 100);
      closes.set([...closes().slice(1), price()]);
    };
    const lo = () => Math.min(...closes());
    const hi = () => Math.max(...closes());
    return (
      <HoverCard
        {...exit}
        offset={6}
        margin={8}
        onOpenChange={changed(`$${q.symbol}`)}
        onOpen={() => (timer = setInterval(tick, 900))}
        onClose={() => {
          clearInterval(timer);
          flash.set(null);
        }}
        trigger={
          <View
            testID={`ticker-${q.symbol}`}
            focusable
            accessibilityLabel={`${q.symbol} ${price().toFixed(2)}`}
            hoverStyle={{ backgroundColor: alpha(toneColor(tone()), 0.16) }}
            focusStyle={focusRing(1)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, height: pointer ? 26 : 32, borderRadius: 13, borderWidth: 1, borderColor: alpha(toneColor(tone()), 0.25), backgroundColor: alpha(toneColor(tone()), 0.08), transitionProperty: "background-color", transitionDuration: 120 }}
          >
            <Text style={{ fontSize: small, fontWeight: "600", fontFamily: mono, color: colors.text }}>${q.symbol}</Text>
            <Text style={{ fontSize: small, fontVariant: ["tabular-nums"], color: toneColor(tone()) }}>
              {change() >= 0 ? "▲" : "▼"} {Math.abs((change() / q.open) * 100).toFixed(2)}%
            </Text>
          </View>
        }
      >
        <PopIn style={popoverLook({ width: pointer ? 260 : 290 })}>
          <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: pointer ? 15 : 17, fontWeight: "600", color: colors.text }}>{q.symbol}</Text>
              <Text style={{ fontSize: small, color: colors.muted }}>{q.name}</Text>
            </View>
            <Badge label="Live" tone="up" outline />
          </View>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <View style={{ borderRadius: 5, paddingHorizontal: 3, marginHorizontal: -3, backgroundColor: flash() ? alpha(toneColor(flash()!), 0.18) : "transparent", transitionProperty: "background-color", transitionDuration: 400 }}>
              <Text style={{ fontSize: 26, fontWeight: "600", fontVariant: ["tabular-nums"], color: colors.text }}>{price().toFixed(2)}</Text>
            </View>
            <Text style={{ fontSize: body, fontVariant: ["tabular-nums"], color: toneColor(tone()) }}>
              {change() >= 0 ? "+" : ""}
              {change().toFixed(2)} ({((change() / q.open) * 100).toFixed(2)}%)
            </Text>
          </View>
          {/* The day's closes as bars, the latest at the right; a terminal's
              are a row of block glyphs, eighths of a Cell, as a sparkline is. */}
          <If when={terminal}>
            <Text style={{ color: toneColor(tone()) }}>
              {closes()
                .map((c) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.floor(((c - lo()) / Math.max(0.01, hi() - lo())) * 8))])
                .join("")}
            </Text>
          </If>
          <View style={{ height: 44, flexDirection: "row", alignItems: "flex-end", gap: 2, display: terminal ? "none" : "flex" }}>
            <Each of={closes()}>
              {(c, i) => (
                <View
                  style={{
                    flex: 1,
                    height: 6 + ((c() - lo()) / Math.max(0.01, hi() - lo())) * 38,
                    borderRadius: 1.5,
                    backgroundColor: i() === closes().length - 1 ? toneColor(tone()) : alpha(toneColor(tone()), 0.35),
                    transitionProperty: "height",
                    transitionDuration: 300,
                  }}
                />
              )}
            </Each>
          </View>
          <View style={{ flexDirection: "row" }}>
            <Stat label="Open" value={q.open.toFixed(2)} width="33%" />
            <Stat label="Volume" value={q.volume} width="33%" />
            <Stat label="Mkt cap" value={q.cap} width="33%" />
          </View>
        </PopIn>
      </HoverCard>
    );
  }

  function Tickers() {
    return (
      <Card icon="chart" title="A stock ticker" subtitle="A live quote behind each symbol: it ticks only while its card is open (onOpen to onClose)">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Ticker quote={quotes.AAPL} />
          <Ticker quote={quotes.NVDA} />
          <Ticker quote={quotes.TSLA} />
        </View>
        <Caption label={hint("Tap a symbol", "Tab to a symbol: the keyboard focus opens its card too")} />
      </Card>
    );
  }

  function Delays() {
    const open = signal("600");
    const close = signal("300");
    const side = signal<PopupSide>("bottom");
    return (
      <Card icon="sliders" title="Delays and placement" subtitle="openDelay keeps it from flashing open; closeDelay leaves time to reach it">
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 12, color: colors.muted }}>openDelay</Text>
          <Segmented size="small" options={[{ value: "0", label: "0" }, { value: "300", label: "300" }, { value: "600", label: "600" }, { value: "1200", label: "1200" }]} value={open()} onChange={(v) => open.set(v)} />
          <Text style={{ fontSize: 12, color: colors.muted }}>closeDelay</Text>
          <Segmented size="small" options={[{ value: "0", label: "0" }, { value: "300", label: "300" }, { value: "1000", label: "1000" }]} value={close()} onChange={(v) => close.set(v)} />
          <Segmented size="small" options={[{ value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }, { value: "left", label: "Left" }, { value: "right", label: "Right" }]} value={side()} onChange={(v) => side.set(v)} />
        </View>
        <View style={{ alignItems: "center", paddingVertical: pointer ? 36 : 24 }}>
          <HoverCard
            {...exit}
            openDelay={Number(open())}
            closeDelay={Number(close())}
            placement={side()}
            offset={8}
            margin={8}
            onOpenChange={changed("delays")}
            trigger={
              <View focusable hoverStyle={{ backgroundColor: alpha(colors.text, 0.06) }} focusStyle={focusRing(1)} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, height: pointer ? 28 : 40, borderRadius: 8, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border }}>
                <LucideIcon name="hand" size={14} tint={colors.muted} />
                <Text style={{ fontSize: body, color: colors.text }}>{pointer ? "Rest here" : "Tap here"}</Text>
              </View>
            }
          >
            <PopIn side={side()} style={{ ...popoverLook({ compact: true }), maxWidth: 220 }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>
                {open()} ms in · {close()} ms out
              </Text>
              <Text style={{ fontSize: 12, color: colors.muted }}>Placed {side()}; it flips where there is no room.</Text>
            </PopIn>
          </HoverCard>
        </View>
      </Card>
    );
  }

  function Pinned() {
    const open = signal(false);
    const pinned = signal(false);
    return (
      <Card icon="components" title="Controlled" subtitle="The app owns open: pinned, it stays whatever the pointer does">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <HoverCard
            {...exit}
            open={open() || pinned()}
            onOpenChange={(e) => {
              changed("pinned")(e);
              if (!pinned()) open.set(e.open);
            }}
            placement="right"
            offset={8}
            margin={8}
            trigger={
              // A terminal shows the focus itself: no edge kept for a ring,
              // which would take a row above and below.
              <View focusable focusStyle={terminal ? undefined : focusRing(1)} style={{ flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 8, borderWidth: terminal ? 0 : 1, borderColor: "transparent" }}>
                <Avatar name="Ravi Patel" size={pointer ? 28 : 34} />
                <Text style={{ fontSize: body, color: colors.text }}>Build #4182</Text>
              </View>
            }
          >
            <PopIn side="right" style={popoverLook({ width: pointer ? 220 : 240 })}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <LucideIcon name="circle-check" size={16} tint={colors.up} />
                <Text style={{ fontSize: body, fontWeight: "600", color: colors.text }}>Passed in 4m 12s</Text>
              </View>
              <Text style={{ fontSize: small, color: colors.muted }}>842 tests · 3 platforms · started by Ravi Patel</Text>
              <If when={pinned()}>
                <Badge label="Pinned" tone="accent" />
              </If>
            </PopIn>
          </HoverCard>
          <View style={{ flex: 1 }} />
          {/* The switch's name in sight, as the gallery's other switches have
              theirs: alone, a terminal's `[ ]` would say nothing. */}
          <Text style={{ fontSize: small, color: colors.muted }}>Pin open</Text>
          <Toggle label="Pin open" value={pinned()} onChange={(v) => pinned.set(v)} />
        </View>
        <Caption label={pinned() ? "Pinned: onOpenChange still reports, the app keeps it open" : "Pin it, then move away"} />
      </Card>
    );
  }

  return <DemoPage cards={[Thread, Links, Tickers, Delays, Pinned, Events]} />;
}
