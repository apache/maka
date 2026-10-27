import { Canvas, List, Scroll, type ScrollEvent, signal, Text, View, type YNode } from "nsh";
import { Input } from "nsh/base";
import { createAnimatedValue } from "nsh";
import { windowSize } from "nsh";
import { Badge, Button, Caption, colors, DemoPage, Figure, finish, hint, isDark, Meter, mono, Press, radius, Section, Segmented, Toggle as Switch, type Tone, toneColor, toneTint } from "../ui";

const tones: Tone[] = ["accent", "info", "warn", "up", "danger"];

/** A switch row; `code` names the prop it sets. */
function Toggle(props: { label: string; code?: string; note?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 15, color: colors.text }}>{props.label}</Text>
        <If when={props.code}>
          <Text style={{ fontSize: 12, color: colors.faint, fontFamily: mono }}>{props.code}</Text>
        </If>
        <If when={props.note}>
          <Text style={{ fontSize: 13, color: colors.faint }}>{props.note}</Text>
        </If>
      </View>
      <Switch value={props.value} onChange={props.onChange} label={props.label} />
    </View>
  );
}

/** The APIs a section shows, as code. */
function Api(props: { names: string }) {
  return <Text style={{ fontSize: 12, color: colors.faint, fontFamily: mono }}>{props.names}</Text>;
}

const options = <T extends string>(values: readonly T[]) => values.map((value) => ({ value, label: value }));

/** A dot matrix with a low-alpha area and a dashed reference line: a page's backdrop. */
function Backdrop(props: { tone: Tone; seed: number }) {
  return (
    <Canvas
      pointerEvents="none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      draw={(cx, { width, height }) => {
        const color = toneColor(props.tone);
        cx.fillStyle = colors.border;
        for (let x = 10; x < width; x += 12) for (let y = 10; y < height; y += 12) cx.fillRect(x, y, 1.5, 1.5);
        // A wave, filled faintly below.
        const points: [number, number][] = [];
        for (let i = 0; i <= 24; i++) {
          const x = (i / 24) * width;
          const y = height * (0.62 - 0.18 * Math.sin(i * 0.5 + props.seed) - 0.06 * Math.sin(i * 1.3 + props.seed * 2));
          points.push([x, y]);
        }
        cx.beginPath();
        cx.moveTo(0, height);
        for (const [x, y] of points) cx.lineTo(x, y);
        cx.lineTo(width, height);
        cx.closePath();
        cx.fillStyle = toneTint(props.tone);
        cx.fill();
        cx.beginPath();
        points.forEach(([x, y], i) => (i ? cx.lineTo(x, y) : cx.moveTo(x, y)));
        cx.strokeStyle = color;
        cx.lineWidth = 1.5;
        cx.stroke();
        cx.setLineDash([3, 4]);
        cx.strokeStyle = colors.faint;
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(0, height * 0.5);
        cx.lineTo(width, height * 0.5);
        cx.stroke();
      }}
    />
  );
}

const pages = [
  { title: "Revenue", value: "48.2k", note: "+12 %", tone: "accent" },
  { title: "Sessions", value: "9,410", note: "+3 %", tone: "info" },
  { title: "Latency", value: "142", note: "ms p95", tone: "warn" },
  { title: "Uptime", value: "99.98", note: "%", tone: "up" },
  { title: "Errors", value: "17", note: "−40 %", tone: "danger" },
] as const;

/** Full-width pages: one per fling; the indicator and the parallax follow the offset natively. */
function Pager() {
  // Pages as wide as the scroll view (the Section's inset is 32 + 12 + 28 narrower than the window).
  const width = signal(windowSize().width - 72);
  const page = signal(0);
  const x = createAnimatedValue(0);
  const step = 16;
  return (
    <View style={{ gap: 12 }}>
      <Scroll
        horizontal
        pagingEnabled
        scrollbar={false}
        scrollValue={x}
        style={{ height: 160, borderRadius: radius.control, backgroundColor: colors.surface, ...finish.card, borderWidth: 1, borderColor: colors.line }}
        onLayout={(e) => width.set(e.size.width)}
        onMomentumEnd={(e) => page.set(Math.round(e.x / width()))}
        onScrollEnd={(e) => page.set(Math.round(e.x / width()))}
      >
        <View style={{ flexDirection: "row" }}>
          <Each of={pages}>
            {(p, i) => {
              // Read inside the styles, so they follow the width once it is measured.
              const range = () => [(i() - 1) * width(), i() * width(), (i() + 1) * width()];
              return (
                <View style={{ width: width(), height: 160, overflow: "hidden" }}>
                  <Backdrop tone={p().tone} seed={i() * 1.7} />
                  <View
                    style={{
                      padding: 16,
                      gap: 4,
                      // The text lags behind the page and fades at the edges.
                      opacity: x.interpolate({ inputRange: range(), outputRange: [0.1, 1, 0.1] }),
                      transform: [{ translateX: x.interpolate({ inputRange: range(), outputRange: [-width() * 0.35, 0, width() * 0.35] }) }],
                    }}
                  >
                    <Text style={{ fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>
                      {p().title} · {i() + 1} of {pages.length}
                    </Text>
                    <Figure value={p().value} note={p().note} tone={p().tone} />
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
      </Scroll>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View style={{ flexDirection: "row", gap: step - 8 }}>
          <Each of={pages}>{() => <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.raised }} />}</Each>
          <View
            style={{
              position: "absolute",
              left: 0,
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: colors.accent,
              transform: [{ translateX: x.interpolate({ inputRange: [0, (pages.length - 1) * width()], outputRange: [0, (pages.length - 1) * step] }) }],
            }}
          />
        </View>
        <Text style={{ flex: 1, textAlign: "right", fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>Settled on page {page() + 1}</Text>
      </View>
    </View>
  );
}

/** Cards that snap; a fling can pass several unless limited to one. */
function Cards() {
  const card = 220;
  const gap = 12;
  const oneStep = signal(false);
  const align = signal<"start" | "center" | "end">("center");
  return (
    <View style={{ gap: 12 }}>
      <View style={{ marginHorizontal: -14 }}>
        <List
          each={Array.from({ length: 20 }, (_, i) => i)}
          horizontal
          estimatedItemSize={card + gap}
          snapToInterval={card + gap}
          snapToAlignment={align()}
          decelerationRate="fast"
          disableIntervalMomentum={oneStep()}
          scrollbar={false}
          style={{ height: 128 }}
          contentStyle={{ gap, paddingHorizontal: 14 }}
        >
          {(i) => {
            const tone = () => tones[i() % tones.length];
            return (
              <View
                style={{
                  width: card,
                  height: 128,
                  borderRadius: 18,
                  borderCurve: "continuous",
                  backgroundColor: colors.raised,
                  ...finish.raised,
                  borderWidth: 1,
                  borderColor: colors.border,
                  padding: 16,
                  justifyContent: "space-between",
                  overflow: "hidden",
                }}
              >
                <View style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: 3, backgroundColor: toneColor(tone()) }} />
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Text style={{ flex: 1, fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>at {i() * (card + gap)} pt</Text>
                  <Badge label={tone()} tone={tone()} />
                </View>
                <Text style={{ fontSize: 24, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>
                  Card {i() + 1}
                </Text>
              </View>
            );
          }}
        </List>
      </View>
      <Segmented size="small" options={options(["start", "center", "end"] as const)} value={align()} onChange={(v) => align.set(v)} />
      <Toggle label="One card per fling" code="disableIntervalMomentum" value={oneStep()} onChange={(v) => oneStep.set(v)} />
    </View>
  );
}

type Logged = { name: string; y: number; tone: Tone };

/** onScroll (throttled), drag and momentum events, scrollable, bounces, contentInset. */
function Events() {
  const offset = signal<ScrollEvent | null>(null);
  const log = signal<Logged[]>([]);
  const enabled = signal(true);
  const bounces = signal(true);
  const inset = signal(false);
  const throttle = signal<"0" | "100" | "500">("100");
  const note = (name: string, tone: Tone) => (e: { y: number }) => log.update((l) => [{ name, y: Math.round(e.y), tone }, ...l].slice(0, 5));
  const progress = () => {
    const o = offset();
    return o && o.contentSize.height > o.size.height ? o.offset.y / (o.contentSize.height - o.size.height) : 0;
  };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
        <View style={{ flex: 1 }}>
          <Figure value={offset() ? String(Math.round(offset()!.offset.y)) : "0"} unit="pt" note={offset() ? `/ ${Math.round(offset()!.contentSize.height)}` : "Scroll the box"} tone="info" />
        </View>
        <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"], paddingBottom: 6 }}>
          viewport {offset() ? Math.round(offset()!.size.height) : "—"} pt
        </Text>
      </View>
      <Meter value={progress()} tone="info" />
      <Scroll
        style={{ height: 180, borderRadius: radius.control, backgroundColor: colors.surface, ...finish.card, borderWidth: 1, borderColor: colors.line }}
        scrollable={enabled()}
        bounces={bounces()}
        contentInset={inset() ? { top: 40, bottom: 40 } : undefined}
        scrollEventThrottle={Number(throttle())}
        onScroll={(v) => offset.set(v)}
        onScrollDragStart={note("begin drag", "accent")}
        onScrollDragEnd={note("end drag", "warn")}
        onMomentumStart={note("momentum begin", "info")}
        onMomentumEnd={note("momentum end", "up")}
      >
        <View style={{ paddingVertical: 6 }}>
          <Each of={Array.from({ length: 30 }, (_, i) => i + 1)}>
            {(i) => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 32, paddingHorizontal: 12 }}>
                <Text style={{ width: 24, fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"], textAlign: "right" }}>{i()}</Text>
                <View style={{ height: 4, borderRadius: 2, width: `${20 + ((i() * 37) % 70)}%`, backgroundColor: colors.raised }} />
              </View>
            )}
          </Each>
        </View>
      </Scroll>
      <View style={{ gap: 6, minHeight: 5 * 20 }}>
        <If when={log().length} else={<Text style={{ fontSize: 13, color: colors.faint }}>No drags yet</Text>}>
          <Each of={log()}>
            {(entry, i) => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 20, opacity: 1 - i() * 0.16 }}>
                <View style={{ width: 8, height: 8, borderRadius: 2.5, backgroundColor: toneColor(entry().tone) }} />
                <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>{entry().name}</Text>
                <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>at {entry().y} pt</Text>
              </View>
            )}
          </Each>
        </If>
      </View>
      <View style={{ gap: 8 }}>
        <Caption label="Scroll events at most every" note="ms" />
        <Segmented size="small" options={options(["0", "100", "500"] as const)} value={throttle()} onChange={(v) => throttle.set(v)} />
      </View>
      <View>
        <Toggle label="Scroll enabled" code="scrollable" value={enabled()} onChange={(v) => enabled.set(v)} />
        <Toggle label="Bounces" code="bounces" value={bounces()} onChange={(v) => bounces.set(v)} />
        <Toggle label="Content inset" note="40 pt at the top and bottom" value={inset()} onChange={(v) => inset.set(v)} />
      </View>
    </View>
  );
}

/** Pinch to zoom (natively); tap a tile to zoom in on it. */
function Zoom() {
  let scroll: YNode | undefined;
  const scale = signal(1);
  const bounces = signal(true);
  const tiles = Array.from({ length: 24 }, (_, i) => i);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
        <View style={{ flex: 1 }}>
          <Figure value={scale().toFixed(2)} unit="×" note={scale() > 1.01 ? "zoomed in" : scale() < 0.99 ? "zoomed out" : "fit"} tone={scale() > 1.01 ? "accent" : "info"} />
        </View>
        <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"], paddingBottom: 6 }}>0.5× to 5×</Text>
      </View>
      <Scroll
        ref={scroll}
        style={{ height: 240, borderRadius: radius.control, backgroundColor: colors.surface, ...finish.card, borderWidth: 1, borderColor: colors.line }}
        minimumZoomScale={0.5}
        maximumZoomScale={5}
        bouncesZoom={bounces()}
        centerContent
        scrollEventThrottle={50}
        onScroll={(e) => scale.set(e.zoomScale)}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", padding: 6, gap: 6 }}>
          <Each of={tiles}>
            {(tile) => {
              const i = tile();
              const tone = tones[(i * 7) % tones.length];
              return (
                <View
                  style={{
                    width: 74,
                    height: 50,
                    borderRadius: 10,
                    borderCurve: "continuous",
                    backgroundColor: toneTint(tone),
                    borderWidth: 1,
                    borderColor: colors.border,
                    padding: 6,
                    justifyContent: "space-between",
                  }}
                  onPress={() => {
                    // The tile's middle, in the content's (unzoomed) points.
                    const x = 6 + (i % 4) * 80 + 37;
                    const y = 6 + Math.floor(i / 4) * 56 + 25;
                    scroll?.zoomTo({ scale: scale() < 2.5 ? 3 : 1, x, y });
                  }}
                >
                  <View style={{ width: 12, height: 3, borderRadius: 1.5, backgroundColor: toneColor(tone) }} />
                  <Text style={{ color: colors.text, fontSize: 11, fontVariant: ["tabular-nums"] }}>Tile {i + 1}</Text>
                </View>
              );
            }}
          </Each>
        </View>
      </Scroll>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button label="0.5×" variant="secondary" onPress={() => scroll?.zoomTo({ scale: 0.5 })} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="1×" onPress={() => scroll?.zoomTo({ scale: 1 })} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="2×" variant="secondary" onPress={() => scroll?.zoomTo({ scale: 2 })} />
        </View>
      </View>
      <Toggle label="Bounces past the limits" code="bouncesZoom" value={bounces()} onChange={(v) => bounces.set(v)} />
    </View>
  );
}

type Post = { id: number; label: string; fresh: boolean; tone: Tone };

/** New items arrive at the top; the rows on screen stay where they are. */
function Feed() {
  let next = 0;
  const post = (label: string, fresh: boolean): Post => ({ id: next, label, fresh, tone: tones[next++ % tones.length] });
  const posts = signal(Array.from({ length: 30 }, (_, i) => post(`Post ${i + 1}`, false)));
  let fresh = 0;
  const addOnTop = () => posts.update((p) => [...Array.from({ length: 3 }, () => post(`New ${++fresh}`, true)), ...p]);
  return (
    <View style={{ gap: 12 }}>
      <List
        each={posts()}
        estimatedItemSize={48}
        style={{ height: 240, borderRadius: radius.control, backgroundColor: colors.surface, ...finish.card, borderWidth: 1, borderColor: colors.line }}
      >
        {(p) => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 48, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.line }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p().fresh ? colors.accent : colors.raised }} />
            <Text style={{ flex: 1, fontSize: 15, color: p().fresh ? colors.text : colors.muted }}>{p().label}</Text>
            {p().fresh ? <Badge label="new" tone="accent" /> : <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>#{p().id}</Text>}
          </View>
        )}
      </List>
      <Caption label="Scroll down a little, then add" note={`${posts().length} posts`} />
      <Button label="Add 3 posts on top" icon="plus" onPress={addOnTop} />
    </View>
  );
}

type Taps = "never" | "handled" | "always";

export function Scrolling() {
  const taps = signal<Taps>("never");
  const presses = signal(0);
  return (
    <DemoPage
      appear={false}
      bottom={16}
      keyboardShouldPersistTaps={taps()}
      cards={[
        () => (
          <Section title="Paging" note="5 pages">
            <Api names="pagingEnabled · scrollValue" />
            <Pager />
          </Section>
        ),
        () => (
          <Section title="Snapping" note="20 cards">
            <Api names="snapToInterval · snapToAlignment" />
            <Cards />
          </Section>
        ),
        () => (
          <Section title="Zoom" note={hint("Pinch or tap a tile", "Pinch on a touchpad or click a tile")}>
            <Api names="maximumZoomScale · zoomTo()" />
            <Zoom />
          </Section>
        ),
        () => (
          <Section title="Events and behavior">
            <Api names="onScroll · onScrollDragStart · onMomentumEnd" />
            <Events />
          </Section>
        ),
        () => (
          <Section title="Prepending keeps the position">
            <Feed />
          </Section>
        ),
        () => (
          <Section title="Taps with the keyboard up">
            <Api names="keyboardShouldPersistTaps" />
            <Segmented size="small" options={options(["never", "handled", "always"] as const)} value={taps()} onChange={(v) => taps.set(v)} />
            <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>
              {taps() === "never"
                ? "A tap outside the input only hides the keyboard; the button does not get it."
                : taps() === "handled"
                  ? "The button gets the tap and the keyboard stays; a tap on empty space hides it."
                  : "Taps never hide the keyboard."}
            </Text>
            <Input
              placeholder={hint("Type here, then tap the button", "Type here, then click the button")}
              style={{
                placeholderColor: colors.faint,
                selectionColor: colors.accent,
                height: 44,
                fontSize: 15,
                color: colors.text,
                backgroundColor: colors.field,
                ...finish.field,
                borderWidth: 1,
                borderColor: colors.fieldBorder,
                borderRadius: radius.control,
                paddingHorizontal: 14,
              }}
            />
            <Press onPress={() => presses.set(presses() + 1)} accessibilityLabel="Count a tap">
              <View
                style={{
                  height: 44,
                  borderRadius: radius.control,
                  borderCurve: "continuous",
                  backgroundColor: colors.light,
                  ...finish.light,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: "600", color: colors.onLight }}>{hint("Tap me", "Click me")}</Text>
                <Text style={{ fontSize: 15, color: isDark() ? "#55595f" : "#9a9ea4", fontVariant: ["tabular-nums"] }}>{presses()}</Text>
              </View>
            </Press>
            <View style={{ height: 300 }} />
          </Section>
        ),
      ]}
    />
  );
}
