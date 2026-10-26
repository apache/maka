import { batch, cleanup, computed, context, effect, mount, Scroll, signal, Text, untracked, View } from "nsh";
import { button, buttonText, focusRing, tint, ui, wide } from "./palette";

/** The accent's palette key: a key, not a colour, so it follows the theme. */
type Swatch = "accent" | "info" | "up" | "violet";
const Accent = context(signal<Swatch>("accent"));

/** A button filled with a palette colour instead of a surface. */
const filled = (color: () => string) => () => ({ backgroundImage: "none", backgroundColor: color(), borderColor: "rgba(0,0,0,0)", boxShadow: "none" });

/** A stopwatch: the effect starts a timer and its cleanup stops it. */
function Stopwatch() {
  const running = signal(false);
  const tenths = signal(0);
  effect(() => {
    if (!running()) return;
    const id = setInterval(() => tenths.update((t) => t + 1), 100);
    cleanup(() => clearInterval(id));
  });
  const accent = Accent();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Text style={{ flex: 1, fontSize: 28, fontWeight: "600", fontVariant: ["tabular-nums"], color: ui().text }}>
        {(tenths() / 10).toFixed(1)} s
      </Text>
      <View onPress={() => running.set(!running())} {...button("primary", { style: filled(() => ui()[accent()]) })}>
        <Text style={{ ...buttonText(), color: ui().page }}>{running() ? "Stop" : "Start"}</Text>
      </View>
      <View onPress={() => tenths.set(0)} {...button()}>
        <Text style={buttonText()}>Reset</Text>
      </View>
    </View>
  );
}

function Section(props: { title: string; children: any }) {
  return (
    <View style={{ ...ui().card, borderRadius: 16, padding: 14, gap: 10 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: ui().muted }}>{props.title}</Text>
      {props.children}
    </View>
  );
}

function App() {
  const price = signal(12);
  const quantity = signal(1);
  const total = computed(() => price() * quantity());
  const writes = signal(0);
  const accent = Accent();

  // Runs again whenever `total` changes; reads of `writes` are not tracked.
  const log = signal<string[]>([]);
  effect(() => {
    const t = total();
    const n = untracked(writes);
    log.update((l) => [`total ${t} after ${n} writes`, ...l].slice(0, 3));
  });

  const step = (dp: number, dq: number) => {
    batch(() => {
      price.update((p) => Math.max(0, p + dp));
      quantity.update((q) => Math.max(0, q + dq));
      writes.update((w) => w + 2);
    });
  };

  const swatches: Swatch[] = ["accent", "info", "up", "violet"];

  return (
    <Scroll style={{ flex: 1, backgroundColor: ui().page }}>
      <View
        style={
          wide()
            ? { padding: 20, paddingTop: 24, gap: 16, display: "grid", gridTemplateColumns: "repeat(2, 1fr)" }
            : { padding: 20, paddingTop: 24, gap: 16 }
        }
      >
        <Section title="signal + computed">
          <Text style={{ fontSize: 17, color: ui().text }}>
            {price()} × {quantity()} = <Text style={{ fontWeight: "700", color: ui()[accent()] }}>{total()}</Text>
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View onPress={() => step(1, 0)} {...button()}>
              <Text style={buttonText()}>price +1</Text>
            </View>
            <View onPress={() => step(0, 1)} {...button()}>
              <Text style={buttonText()}>qty +1</Text>
            </View>
            <View
              onPress={() => step(1, 1)}
              {...button("secondary", { style: () => ({ backgroundImage: "none", backgroundColor: tint(ui().warn, 0.14), borderColor: tint(ui().warn, 0.3), boxShadow: "none" }) })}
            >
              <Text style={{ ...buttonText(), color: ui().warn }}>both (batch)</Text>
            </View>
          </View>
        </Section>

        <Section title="effect + untracked">
          <Each of={log()}>{(line) => <Text style={{ fontSize: 13, color: ui().muted }}>{line()}</Text>}</Each>
        </Section>

        <Section title="effect + cleanup">
          <Stopwatch />
        </Section>

        <Section title="context (the value is a signal)">
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Each of={swatches}>
              {(c) => (
                <View
                  onPress={() => accent.set(c())}
                  style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: ui()[c()], borderWidth: 3, borderColor: accent() === c() ? ui().text : "transparent" }}
                  hoverStyle={{ opacity: 0.88 }}
                  focusStyle={focusRing()}
                  activeStyle={{ opacity: 0.7 }}
                />
              )}
            </Each>
          </View>
        </Section>
      </View>
    </Scroll>
  );
}

mount(() => (
  <Accent.Provider value={signal<Swatch>("accent")}>
    <App />
  </Accent.Provider>
));
