import { cleanup, createAnimatedValue, effect, Image, platform, reduceMotion, signal, Text, View, type ViewStyle } from "nsh";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPagination, CarouselPaginationItem, CarouselPrevious } from "nsh/base";
import { alpha, Badge, Button, Caption, Card, chart, colors, DemoPage, finish, focusRing, mono, Press, radius } from "../ui";
import { LucideIcon, type LucideIconName } from "../icons";

// `nsh/base`'s `Carousel` owns the scrolling (the platform's own: the
// slides follow a finger, the wheel and the touchpad, and snap to a slide
// on release), which slide shows, the keys, a seamless loop and what
// screen readers hear; its parts find it through context. The app owns the
// index where it wants to (the onboarding's buttons, the banners' and the
// ticker's own timers, held while the user is at them through the
// carousel's `onDragStart` / `onDragEnd` and `onFocus` / `onBlur` and the
// pointer over a view around it), every label and every look:
// the gallery's dots with a pill that springs between them, thumbnails
// with a ring, glass arrows over a photo, banners that roll on by
// themselves, a row of cards three to a view, and a ticker that rolls up.

const pointer = platform.idiom === "desktop";
/** The sizes of the page: a pointer's compact tier, a touch screen's roomier one. */
const size = pointer
  ? { title: 15, body: 13, caption: 12, arrow: 30, arrowIcon: 16, thumb: 52, dot: 7, hit: 15, bar: 18 }
  : { title: 17, body: 15, caption: 13, arrow: 38, arrowIcon: 18, thumb: 60, dot: 8, hit: 22, bar: 22 };

/** A fade every control here shares; nothing moves with reduced motion. */
const fade = (): ViewStyle => ({
  transitionProperty: "background-color, border-color, opacity, transform",
  transitionDuration: reduceMotion() ? 0 : 160,
  transitionTimingFunction: "ease-out",
});

/** A control under a press: it sinks a little. */
const sink: ViewStyle = { transform: [{ scale: 0.92 }] };
/** A control with nothing to move to (the first slide's previous). */
const spent: ViewStyle = { opacity: 0.3 };

/**
 * Slides that move on by themselves, the app's: a controlled index the
 * app's timer moves on every `ms`, around the ends, starting a whole
 * interval again after each change (a press of the user's included). It
 * holds while the pointer is over the carousel, while the keyboard focus
 * is in it and while the user drags it, and stays off with reduced motion
 * and while `playing` is off (the rotation control).
 */
function rotation(count: number, ms: number, onTick?: (index: number) => void) {
  const index = signal(0);
  const playing = signal(true);
  const hovered = signal(false);
  const focused = signal(false);
  const dragging = signal(false);
  const held = () => hovered() || focused() || dragging();
  const running = () => playing() && !held() && !reduceMotion();
  effect(() => {
    index();
    if (!running()) return;
    const timer = setInterval(() => {
      const next = (index() + 1) % count;
      index.set(next);
      onTick?.(next);
    }, ms);
    cleanup(() => clearInterval(timer));
  });
  return {
    index,
    playing,
    held,
    running,
    /** What the badge says: off, paused by the user, held by the user, or rolling. */
    status: () => (reduceMotion() ? "Off: reduced motion" : !playing() ? "Paused" : held() ? "On hold" : "Playing"),
    /** The pointer's half: on a view around the carousel. */
    hover: {
      onMouseEnter: () => hovered.set(true),
      onMouseLeave: () => hovered.set(false),
    },
    /** The carousel's half: its index, its changes, its focus and drags. */
    carousel: {
      onFocus: () => focused.set(true),
      onBlur: () => focused.set(false),
      onDragStart: () => dragging.set(true),
      onDragEnd: () => dragging.set(false),
    },
  };
}

const STEPS: { icon: LucideIconName; title: string; body: string; tone: () => string }[] = [
  { icon: "sparkles", title: "Welcome to Field Notes", body: "Capture ideas the moment they arrive, from any device.", tone: () => chart.s1 },
  { icon: "folder-input", title: "Import what you have", body: "Bring notes in from files, the clipboard or another app.", tone: () => colors.info },
  { icon: "share-2", title: "Share with your team", body: "Invite people to a notebook; edits sync as they type.", tone: () => colors.up },
  { icon: "bell", title: "Stay in the loop", body: "Get a nudge when someone mentions you or a task is due.", tone: () => colors.warn },
];

const PHOTOS = [
  { id: 1036, caption: "Front, natural light" },
  { id: 1039, caption: "Detail of the weave" },
  { id: 1043, caption: "In the living room" },
  { id: 1044, caption: "Side profile" },
  { id: 1050, caption: "Folded for travel" },
  { id: 1067, caption: "Packaging" },
];

const BANNERS: { tag: string; title: string; body: string; from: string; to: string }[] = [
  { tag: "New", title: "Autumn collection", body: "Layers for the first cold mornings", from: "#2f4a3a", to: "#7d9a5b" },
  { tag: "Sale", title: "Up to 40% off", body: "Selected outdoor gear, this week only", from: "#4a2f3d", to: "#b5677d" },
  { tag: "Event", title: "Repair café, Saturday", body: "Bring a broken thing, leave with a fixed one", from: "#2f3a4a", to: "#5b7d9a" },
  { tag: "Members", title: "Free returns, always", body: "Join in a minute, cancel any time", from: "#4a422f", to: "#a8925b" },
];

const COLLECTIONS: { name: string; count: number; icon: LucideIconName; tone: () => string }[] = [
  { name: "Reading list", count: 24, icon: "file-text", tone: () => chart.s1 },
  { name: "Recipes", count: 61, icon: "coffee", tone: () => colors.warn },
  { name: "Trips", count: 9, icon: "map-pin", tone: () => colors.info },
  { name: "Inbox", count: 132, icon: "inbox", tone: () => chart.s3 },
  { name: "Design", count: 47, icon: "palette", tone: () => colors.up },
  { name: "Archive", count: 512, icon: "archive", tone: () => chart.s4 },
  { name: "Ideas", count: 18, icon: "sparkles", tone: () => colors.danger },
];

const NEWS = [
  "Offline mode is here: notes sync when you are back",
  "Dark mode follows your system, or pick your own",
  "Shared notebooks now show who is typing",
  "Search finds words inside images and PDFs",
];

/** A round button over the content, or beside it: glass on a photo, raised on a card. */
function arrow(glass: boolean): ViewStyle {
  return {
    width: size.arrow,
    height: size.arrow,
    borderRadius: size.arrow / 2,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    ...(glass ? { ...finish.glass, borderColor: alpha("#ffffff", 0.24) } : finish.raised),
    ...fade(),
  };
}

/**
 * Carousel and its parts: an onboarding the app steps through with its own
 * buttons, a product's photos with thumbnails and arrows, banners that
 * roll on by themselves and wait under the pointer, a row of cards three to
 * a view, and a vertical ticker.
 */
export function CarouselDemo() {
  const last = signal("—");

  function Onboarding() {
    const step = signal(0);
    const done = signal(false);
    const lastStep = STEPS.length - 1;
    // The finished state pops in once.
    const pop = createAnimatedValue(1);
    const complete = () => {
      done.set(true);
      last.set("Onboarding: done");
      if (reduceMotion()) return;
      pop.set(0.6);
      pop.spring(1, { stiffness: 420, damping: 14 });
    };
    return (
      <Card title="Onboarding" subtitle="One step per view; the app's buttons own the index" right={<Badge label={done() ? "Done" : `Step ${step() + 1} of ${STEPS.length}`} tone={done() ? "up" : "neutral"} />}>
        <If
          when={!done()}
          else={
            <View style={{ height: pointer ? 236 : 268, alignItems: "center", justifyContent: "center", gap: 12, transform: [{ scale: pop }] }}>
              <View style={{ width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", backgroundColor: alpha(colors.up, 0.16), borderWidth: 1, borderColor: alpha(colors.up, 0.4) }}>
                <LucideIcon name="check" size={24} tint={colors.up} />
              </View>
              <Text style={{ fontSize: size.title, fontWeight: "600", color: colors.text }}>You are all set</Text>
              <Button
                label="Start over"
                variant="secondary"
                size="small"
                onPress={() => {
                  step.set(0);
                  done.set(false);
                  last.set("Onboarding: start over");
                }}
              />
            </View>
          }
        >
          <Carousel
            index={step()}
            accessibilityLabel="Getting started"
            onChange={({ index }) => {
              step.set(index);
              last.set(`Onboarding: step ${index + 1}`);
            }}
            style={{ gap: 14 }}
          >
            <CarouselContent style={{ height: pointer ? 160 : 188 }}>
              <Each of={STEPS}>
                {(s, i) => (
                  <CarouselItem accessibilityLabel={`${i() + 1} of ${STEPS.length}: ${s().title}`} style={{ width: "100%", alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 24 }}>
                    <View
                      style={{
                        width: pointer ? 48 : 56,
                        height: pointer ? 48 : 56,
                        borderRadius: 16,
                        borderCurve: "continuous",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: alpha(s().tone(), 0.16),
                        borderWidth: 1,
                        borderColor: alpha(s().tone(), 0.4),
                      }}
                    >
                      <LucideIcon name={s().icon} size={pointer ? 22 : 26} tint={s().tone()} />
                    </View>
                    <Text style={{ fontSize: size.title, fontWeight: "600", color: colors.text, textAlign: "center" }}>{s().title}</Text>
                    <Text style={{ fontSize: size.body, color: colors.muted, textAlign: "center", maxWidth: 320 }}>{s().body}</Text>
                  </CarouselItem>
                )}
              </Each>
            </CarouselContent>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Button
                label="Back"
                variant="ghost"
                size="small"
                disabled={step() === 0}
                onPress={() => {
                  step.set(step() - 1);
                  last.set(`Onboarding: back to ${step() + 1}`);
                }}
              />
              <View style={{ flex: 1, alignItems: "center" }}>
                <CarouselPagination
                  accessibilityLabel="Steps"
                  style={{ flexDirection: "row", alignItems: "center" }}
                  // A pill a dot high and twice as wide, springing to the step shown.
                  indicatorStyle={{ top: (size.hit - size.dot) / 2, bottom: (size.hit - size.dot) / 2, marginHorizontal: 1, borderRadius: size.dot / 2, backgroundColor: colors.accentFill }}
                >
                  <Each of={STEPS}>
                    {(s, i) => (
                      // A touch-sized item around its dot; the dot hides under the pill.
                      <CarouselPaginationItem
                        index={i()}
                        accessibilityLabel={`Step ${i() + 1}: ${s().title}`}
                        class="group"
                        style={{ width: size.hit + 4, height: size.hit, alignItems: "center", justifyContent: "center", borderRadius: size.hit / 2 }}
                        focusStyle={focusRing()}
                      >
                        <View
                          class="opacity-70 group-hover:opacity-100 group-selected:opacity-0"
                          style={{ width: size.dot, height: size.dot, borderRadius: size.dot / 2, backgroundColor: alpha(colors.text, 0.24), ...fade() }}
                        />
                      </CarouselPaginationItem>
                    )}
                  </Each>
                </CarouselPagination>
              </View>
              <Button
                label={step() === lastStep ? "Done" : "Next"}
                icon={step() === lastStep ? "check" : undefined}
                size="small"
                onPress={() => {
                  if (step() === lastStep) complete();
                  else {
                    step.set(step() + 1);
                    last.set(`Onboarding: next to ${step() + 1}`);
                  }
                }}
              />
            </View>
          </Carousel>
        </If>
      </Card>
    );
  }

  function Product() {
    const photo = signal(0);
    return (
      <Card title="Product photos" subtitle="Thumbnails pick a photo; arrows over its edges" right={<Badge label={`${photo() + 1} / ${PHOTOS.length}`} />}>
        <Carousel
          accessibilityLabel="Photos of the Linen throw"
          onChange={({ index }) => {
            photo.set(index);
            last.set(`Photo: ${PHOTOS[index].caption}`);
          }}
          style={{ gap: 10 }}
        >
          <View>
            <CarouselContent style={{ aspectRatio: 4 / 3, borderRadius: radius.inset, borderCurve: "continuous", backgroundColor: colors.raised }}>
              <Each of={PHOTOS}>
                {(p, i) => (
                  <CarouselItem accessibilityLabel={`${i() + 1} of ${PHOTOS.length}: ${p().caption}`} style={{ width: "100%", height: "100%" }}>
                    <Image src={`https://picsum.photos/id/${p().id}/960/720`} style={{ width: "100%", height: "100%", backgroundColor: colors.raised }} />
                  </CarouselItem>
                )}
              </Each>
            </CarouselContent>
            <CarouselPrevious
              accessibilityLabel="Previous photo"
              style={{ ...arrow(true), position: "absolute", left: 10, top: "50%", marginTop: -size.arrow / 2 }}
              hoverStyle={{ backgroundColor: alpha("#000000", 0.45) }}
              activeStyle={sink}
              focusStyle={focusRing(2)}
              disabledStyle={spent}
            >
              <LucideIcon name="chevron-left" size={size.arrowIcon} tint="#ffffff" />
            </CarouselPrevious>
            <CarouselNext
              accessibilityLabel="Next photo"
              style={{ ...arrow(true), position: "absolute", right: 10, top: "50%", marginTop: -size.arrow / 2 }}
              hoverStyle={{ backgroundColor: alpha("#000000", 0.45) }}
              activeStyle={sink}
              focusStyle={focusRing(2)}
              disabledStyle={spent}
            >
              <LucideIcon name="chevron-right" size={size.arrowIcon} tint="#ffffff" />
            </CarouselNext>
          </View>
          <CarouselPagination accessibilityLabel="Choose a photo" style={{ flexDirection: "row", gap: 8 }}>
            <Each of={PHOTOS}>
              {(p, i) => (
                <CarouselPaginationItem
                  index={i()}
                  accessibilityLabel={`Photo ${i() + 1}: ${p().caption}`}
                  style={{
                    // Six share the row's width, up to their size: they
                    // fit a phone and the desktop's narrow column.
                    flex: 1,
                    maxWidth: size.thumb,
                    height: size.thumb * 0.75,
                    padding: 2,
                    borderRadius: 8,
                    borderCurve: "continuous",
                    borderWidth: 2,
                    borderColor: "transparent",
                    opacity: 0.6,
                    ...fade(),
                  }}
                  selectedStyle={{ borderColor: colors.accent, opacity: 1 }}
                  hoverStyle={{ opacity: 0.85 }}
                  activeStyle={{ transform: [{ scale: 0.94 }] }}
                  focusStyle={focusRing(1)}
                >
                  <Image src={`https://picsum.photos/id/${p().id}/160/120`} style={{ flex: 1, borderRadius: 5, backgroundColor: colors.raised }} />
                </CarouselPaginationItem>
              )}
            </Each>
          </CarouselPagination>
        </Carousel>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text style={{ flex: 1, fontSize: size.title, fontWeight: "600", color: colors.text }}>Linen throw</Text>
          <Text style={{ fontSize: size.title, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>$89</Text>
        </View>
        <Caption label={PHOTOS[photo()].caption} note={pointer ? "← → while focused, or the touchpad" : "Swipe, or tap a thumbnail"} />
      </Card>
    );
  }

  function Banners() {
    const roll = rotation(BANNERS.length, 4000, (i) => last.set(`Banner: ${BANNERS[i].title}`));
    const { playing } = roll;
    const shown = roll.index;
    return (
      <Card
        title="Banners"
        subtitle={pointer ? "The app rolls them on every 4 s, past the last to the first; on hold under the pointer" : "The app rolls them on every 4 s, past the last to the first; on hold while you swipe"}
        right={<Badge label={roll.status()} tone={roll.running() ? "accent" : "neutral"} />}
      >
        {/* The pointer over the banners holds them: a view of the app's around the carousel. */}
        <View {...roll.hover}>
        <Carousel
          looping
          index={shown()}
          accessibilityLabel="Promotions"
          onChange={({ index }) => {
            shown.set(index);
            last.set(`Banner: ${BANNERS[index].title}`);
          }}
          {...roll.carousel}
          style={{ gap: 10 }}
        >
          <CarouselContent style={{ height: pointer ? 132 : 156, borderRadius: radius.inset, borderCurve: "continuous" }}>
            <Each of={BANNERS}>
              {(b, i) => (
                <CarouselItem
                  accessibilityLabel={`${i() + 1} of ${BANNERS.length}: ${b().title}`}
                  style={{
                    width: "100%",
                    height: "100%",
                    padding: pointer ? 18 : 20,
                    justifyContent: "flex-end",
                    gap: 4,
                    backgroundColor: b().from,
                    backgroundImage: `linear-gradient(120deg, ${b().from} 0%, ${b().to} 100%)`,
                  }}
                >
                  <View style={{ position: "absolute", top: 14, left: pointer ? 18 : 20, paddingHorizontal: 8, height: 20, borderRadius: 10, justifyContent: "center", backgroundColor: alpha("#ffffff", 0.18) }}>
                    <Text style={{ fontSize: 11, fontWeight: "600", color: "#ffffff", letterSpacing: 0.4 }}>{b().tag.toUpperCase()}</Text>
                  </View>
                  <Text style={{ fontSize: pointer ? 20 : 22, fontWeight: "700", color: "#ffffff" }}>{b().title}</Text>
                  <Text style={{ fontSize: size.body, color: alpha("#ffffff", 0.82) }}>{b().body}</Text>
                </CarouselItem>
              )}
            </Each>
          </CarouselContent>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {/* The rotation control, first, as WAI-ARIA's carousel has it. */}
            <Press
              accessibilityLabel={playing() ? "Pause slides" : "Play slides"}
              onPress={() => {
                playing.set(!playing());
                last.set(`Banners: ${playing() ? "playing" : "paused"}`);
              }}
              scale={0.92}
              style={arrow(false)}
              hoverStyle={finish.hover}
            >
              <LucideIcon name={playing() ? "pause" : "play"} size={size.arrowIcon - 4} tint={colors.text} />
            </Press>
            <CarouselPagination
              accessibilityLabel="Choose a promotion"
              style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 4 }}
              // A bar 4 high on the item of the banner shown, gliding to the next.
              indicatorStyle={{ top: (size.hit - 4) / 2, bottom: (size.hit - 4) / 2, borderRadius: 2, backgroundColor: colors.accentFill }}
            >
              <Each of={BANNERS}>
                {(b, i) => (
                  // A touch-sized item around its bar.
                  <CarouselPaginationItem
                    index={i()}
                    accessibilityLabel={b().title}
                    class="group"
                    style={{ width: size.bar, height: size.hit, justifyContent: "center", borderRadius: 4 }}
                    focusStyle={focusRing()}
                  >
                    <View class="opacity-70 group-hover:opacity-100 group-selected:opacity-0" style={{ height: 4, borderRadius: 2, backgroundColor: alpha(colors.text, 0.22), ...fade() }} />
                  </CarouselPaginationItem>
                )}
              </Each>
            </CarouselPagination>
            <Text style={{ fontSize: size.caption, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${shown() + 1} / ${BANNERS.length}`}</Text>
          </View>
        </Carousel>
        </View>
      </Card>
    );
  }

  function Collections() {
    const first = signal(0);
    // Three to a view with a pointer, a card and a peek on a touch screen;
    // the content's negative margin and each card's padding make the gaps.
    const basis = pointer ? "33.333%" : "78%";
    const gap = 12;
    return (
      <Card title="Collections" subtitle={pointer ? "Three to a view; the last ones rest together" : "One and a peek of the next"}>
        <Carousel
          accessibilityLabel="Collections"
          onChange={({ index }) => {
            first.set(index);
            last.set(`Collections: from ${COLLECTIONS[index].name}`);
          }}
          style={{ gap: 10 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, fontSize: size.caption, color: colors.muted }}>{`${COLLECTIONS.length} collections · from ${COLLECTIONS[first()].name}`}</Text>
            <CarouselPrevious accessibilityLabel="Previous collections" style={arrow(false)} hoverStyle={finish.hover} activeStyle={sink} focusStyle={focusRing(2)} disabledStyle={spent}>
              <LucideIcon name="chevron-left" size={size.arrowIcon} tint={colors.text} />
            </CarouselPrevious>
            <CarouselNext accessibilityLabel="Next collections" style={arrow(false)} hoverStyle={finish.hover} activeStyle={sink} focusStyle={focusRing(2)} disabledStyle={spent}>
              <LucideIcon name="chevron-right" size={size.arrowIcon} tint={colors.text} />
            </CarouselNext>
          </View>
          <CarouselContent style={{ marginLeft: -gap, height: pointer ? 112 : 128 }}>
            <Each of={COLLECTIONS}>
              {(c, i) => (
                <CarouselItem accessibilityLabel={`${i() + 1} of ${COLLECTIONS.length}: ${c().name}`} style={{ flexBasis: basis, paddingLeft: gap, height: "100%" }}>
                  <View
                    style={{
                      flex: 1,
                      padding: 12,
                      justifyContent: "space-between",
                      borderRadius: radius.inset,
                      borderCurve: "continuous",
                      borderWidth: 1,
                      borderColor: colors.line,
                      backgroundColor: colors.inset,
                    }}
                  >
                    <View style={{ width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: alpha(c().tone(), 0.16) }}>
                      <LucideIcon name={c().icon} size={16} tint={c().tone()} />
                    </View>
                    <View style={{ gap: 2 }}>
                      <Text style={{ fontSize: size.body, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{c().name}</Text>
                      <Text style={{ fontSize: size.caption, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`${c().count} notes`}</Text>
                    </View>
                  </View>
                </CarouselItem>
              )}
            </Each>
          </CarouselContent>
        </Carousel>
      </Card>
    );
  }

  function Ticker() {
    const roll = rotation(NEWS.length, 3000);
    const shown = roll.index;
    return (
      <Card title="What's new" subtitle="A vertical carousel: the app rolls the next line up every 3 s, the first after the last">
        <View {...roll.hover}>
        <Carousel
          axis="vertical"
          looping
          index={shown()}
          accessibilityLabel="Announcements"
          onChange={({ index }) => shown.set(index)}
          {...roll.carousel}
          style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
        >
          <LucideIcon name="bell-ring" size={16} tint={colors.accent} />
          <CarouselContent style={{ flex: 1, height: pointer ? 28 : 36 }}>
            <Each of={NEWS}>
              {(n, i) => (
                <CarouselItem accessibilityLabel={`${i() + 1} of ${NEWS.length}`} style={{ height: "100%", justifyContent: "center" }}>
                  <Text style={{ fontSize: size.body, color: colors.text, numberOfLines: 1 }}>{n()}</Text>
                </CarouselItem>
              )}
            </Each>
          </CarouselContent>
          <CarouselPrevious accessibilityLabel="Previous announcement" style={{ ...arrow(false), width: size.arrow - 6, height: size.arrow - 6 }} hoverStyle={finish.hover} activeStyle={sink} focusStyle={focusRing(2)} disabledStyle={spent}>
            <LucideIcon name="arrow-up" size={size.arrowIcon - 4} tint={colors.text} />
          </CarouselPrevious>
          <CarouselNext accessibilityLabel="Next announcement" style={{ ...arrow(false), width: size.arrow - 6, height: size.arrow - 6 }} hoverStyle={finish.hover} activeStyle={sink} focusStyle={focusRing(2)} disabledStyle={spent}>
            <LucideIcon name="arrow-down" size={size.arrowIcon - 4} tint={colors.text} />
          </CarouselNext>
        </Carousel>
        </View>
        <Caption label={pointer ? "↑ ↓ while focused" : "Swipe up or down"} note={`${shown() + 1} of ${NEWS.length}`} />
      </Card>
    );
  }

  function Last() {
    return (
      <Card title="Last event">
        <Text style={{ fontSize: 13, color: colors.text, fontFamily: mono }}>{last()}</Text>
      </Card>
    );
  }

  return <DemoPage cards={[Onboarding, Product, Banners, Collections, Ticker, Last]} />;
}
