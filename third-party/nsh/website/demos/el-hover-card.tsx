import { type JSX, mount, signal, Text, View } from "nsh";
import { HoverCard, type OpenChangeReason } from "nsh/base";
import { desktop, focusRing, Inspector, Log, PopIn, type PopupSide, Segmented, Stage, tint, ui, wide } from "./palette";

type Placement = PopupSide;

/** A card's surface, the look the app gives it; `PopIn` brings it in from the trigger's side. */
const surface = (width: number) => ({ ...ui().card, width, borderRadius: 12, padding: 14, gap: 10 });

/** The popup's box fades on its way out (its ending class, kept while the transition runs). */
const exit = { popupClass: "transition-opacity duration-150 ease-in motion-reduce:transition-none", popupEndingClass: "opacity-0" };

function App() {
  const openDelay = signal(600);
  const closeDelay = signal(300);
  const placement = signal<Placement>("bottom");
  const events = signal<string[]>([]);
  const following = signal(false);
  const price = signal(227.52);
  let timer: ReturnType<typeof setInterval> | undefined;
  const log = (name: string) => ({ open, reason }: { open: boolean; reason: OpenChangeReason }) =>
    events.set([`${name} ${open ? "opened" : "closed"} · ${reason}`, ...events()].slice(0, 6));
  const shared = () => ({ ...exit, openDelay: openDelay(), closeDelay: closeDelay(), placement: placement(), offset: 8, margin: 12 });
  // Running text in a wrapping row: one piece per word, so a line breaks
  // between words, and the row's gap is the space between them.
  const words = (s: string) => s.split(" ").map((w) => <Text style={{ fontSize: 15, color: ui().text }}>{w}</Text>);

  // A mention: the person's card, with a button that works because the
  // pointer can move into the card.
  const mention = () => (
    <HoverCard {...shared()} onOpenChange={log("@ada")} trigger={
      <View role="link" onPress={() => events.set(["onPress /people/ada", ...events()].slice(0, 6))} focusStyle={focusRing(1)} style={{ borderRadius: 4, borderWidth: 1, borderColor: "transparent", paddingHorizontal: 2, marginHorizontal: -3 }} hoverStyle={{ backgroundColor: tint(ui().accent, 0.14) }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: ui().accent }}>@ada</Text>
      </View>
    }>
      <PopIn side={placement()} style={surface(260)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: tint(ui().accent, 0.18), alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: ui().accent }}>AL</Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: ui().text }}>Ada Lovelace</Text>
            <Text style={{ fontSize: 12, color: ui().muted }}>Analyst · Engines</Text>
          </View>
        </View>
        <Text style={{ fontSize: 13, lineHeight: 18, color: ui().text }}>Writes the first programs for the Analytical Engine.</Text>
        <View
          onPress={() => following.set(!following())}
          style={{ height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", ...(following() ? ui().raised : ui().accentFill), transitionProperty: "background-color", transitionDuration: 150 }}
        >
          <Text style={{ fontSize: 13, fontWeight: "500", color: following() ? ui().text : ui().onAccent }}>{following() ? "Following" : "Follow"}</Text>
        </View>
      </PopIn>
    </HoverCard>
  );

  // A link with a preview of the page behind it.
  const preview = () => (
    <HoverCard {...shared()} onOpenChange={log("taffy")} trigger={
      <View role="link" onPress={() => events.set(["onPress github.com/DioxusLabs/taffy", ...events()].slice(0, 6))} focusStyle={focusRing(1)} style={{ borderBottomWidth: 1, borderBottomColor: tint(ui().accent, 0.4) }}>
        <Text style={{ fontSize: 15, color: ui().accent }}>Taffy</Text>
      </View>
    }>
      <PopIn side={placement()} style={{ ...surface(280), padding: 0, gap: 0, overflow: "hidden" }}>
        <View style={{ height: 64, backgroundImage: "linear-gradient(135deg, #3b82f6, #8b5cf6)" }} />
        <View style={{ padding: 12, gap: 4 }}>
          <Text style={{ fontSize: 11, color: ui().faint }}>github.com</Text>
          <Text style={{ fontSize: 14, fontWeight: "600", color: ui().text }}>taffy: flexbox, grid and block layout</Text>
          <Text style={{ fontSize: 12, color: ui().muted }}>A high-performance UI layout library written in Rust.</Text>
        </View>
      </PopIn>
    </HoverCard>
  );

  // A ticker whose quote ticks while its card is open.
  const ticker = () => (
    <HoverCard
      {...shared()}
      onOpenChange={log("$AAPL")}
      onOpen={() => (timer = setInterval(() => price.set(Math.round((price() + (Math.random() - 0.48) * 0.6) * 100) / 100), 900))}
      onClose={() => clearInterval(timer)}
      trigger={
        <View focusable focusStyle={focusRing(1)} style={{ paddingHorizontal: 8, height: 26, borderRadius: 13, justifyContent: "center", borderWidth: 1, borderColor: tint(ui().up, 0.3), backgroundColor: tint(ui().up, 0.1) }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: ui().up }}>$AAPL ▲</Text>
        </View>
      }
    >
      <PopIn side={placement()} style={surface(220)}>
        <Text style={{ fontSize: 12, color: ui().muted }}>Apple Inc. · live</Text>
        <Text style={{ fontSize: 26, fontWeight: "600", color: ui().text, fontVariant: ["tabular-nums"] }}>{price().toFixed(2)}</Text>
        <Text style={{ fontSize: 13, color: price() >= 224.1 ? ui().up : ui().down, fontVariant: ["tabular-nums"] }}>
          {price() >= 224.1 ? "+" : ""}
          {(price() - 224.1).toFixed(2)} today
        </Text>
      </PopIn>
    </HoverCard>
  );

  const stage = (): JSX.Element => (
    <View style={{ gap: 18, alignItems: "flex-start" }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 4, rowGap: 6 }}>
        {words("Ask")}
        {mention()}
        {words("about the layout engine,")}
        {/* The period stays with the link. */}
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          {preview()}
          {words(".")}
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {words("Today:")}
        {ticker()}
      </View>
    </View>
  );
  const controls = () => (
    <>
      <Segmented label="openDelay" options={[0, 300, 600, 1200]} value={openDelay()} onChange={(v) => openDelay.set(v)} />
      <Segmented label="closeDelay" options={[0, 300, 1000]} value={closeDelay()} onChange={(v) => closeDelay.set(v)} />
      <Segmented label="placement" options={["top", "bottom", "left", "right"] as Placement[]} value={placement()} onChange={(v) => placement.set(v)} />
    </>
  );
  const changes = () => <Log title="onOpenChange({ open, reason })" lines={events()} minHeight={110} />;

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>hover card</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Rest the pointer on a mention, a link or a ticker, then move into the card" : "Tap a mention, a link or a ticker; tap outside to close"}
      </Text>

      {() =>
        wide() ? (
          <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
            <Stage gap={24}>{stage()}</Stage>
            <Inspector>
              {controls()}
              {changes()}
            </Inspector>
          </View>
        ) : (
          <>
            {controls()}
            <View style={{ flex: 1, minHeight: 220, justifyContent: "center" }}>{stage()}</View>
            {changes()}
          </>
        )
      }
    </View>
  );
}

mount(App);
