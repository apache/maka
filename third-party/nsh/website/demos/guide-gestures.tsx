import { mount, signal, Text, View } from "nsh";
import { createAnimatedValue } from "nsh";
import { PanResponder } from "nsh";
import { button, buttonText, desktop, focusRing, Inspector, Log, tint, ui, wide } from "./palette";

/** A card dragged on the UI thread: `pan` drives two animated values. */
function DragCard() {
  const x = createAnimatedValue(0);
  const y = createAnimatedValue(0);
  const flings = signal(0);
  return (
    <View style={{ ...ui().inset, height: 150, borderRadius: 12, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <View
        pan={{ x, y }}
        onPanEnd={(e) => {
          flings.update((n) => n + 1);
          // Spring home, starting with the release velocity.
          x.spring(0, { velocity: e.velocityX, stiffness: 200, damping: 16 });
          y.spring(0, { velocity: e.velocityY, stiffness: 200, damping: 16 });
        }}
        style={{
          width: 120,
          height: 80,
          borderRadius: 16,
          ...ui().accentFill,
          alignItems: "center",
          justifyContent: "center",
          transform: [{ translateX: x }, { translateY: y }],
        }}
      >
        <Text style={{ color: ui().onAccent, fontWeight: "700" }}>Drag me</Text>
        <Text style={{ color: ui().onAccent, fontSize: 12 }}>released {flings()}×</Text>
      </View>
    </View>
  );
}

/** A dot moved with PanResponder: every move goes through JS. */
function ResponderDot() {
  const pos = signal({ x: 0, y: 0 });
  const state = signal("idle");
  let start = { x: 0, y: 0 };
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      start = pos();
      state.set("dragging");
    },
    onPanResponderMove: (_, g) => pos.set({ x: start.x + g.dx, y: start.y + g.dy }),
    onPanResponderRelease: (_, g) => state.set(`released, vx ${g.vx.toFixed(2)} pt/ms`),
    onPanResponderTerminate: () => state.set("taken over"),
  });
  return (
    <View style={{ gap: 6 }}>
      <View style={{ ...ui().inset, height: 110, borderRadius: 12, overflow: "hidden" }}>
        <View
          {...responder.panHandlers}
          style={{
            position: "absolute",
            left: 150,
            top: 30,
            width: 50,
            height: 50,
            borderRadius: 25,
            backgroundColor: ui().info,
            transform: [{ translateX: pos().x }, { translateY: pos().y }],
          }}
        />
      </View>
      <Text style={{ color: ui().muted, fontSize: 13 }}>PanResponder: {state()}</Text>
    </View>
  );
}

function App() {
  const log = signal<string[]>([]);
  const add = (event: string) => log.update((l) => [event, ...l].slice(0, 4));
  const dot = signal(0);
  const under = signal(0);
  // With a pointer the buttons are as wide as their labels; on a phone they share the row.
  const share = desktop ? {} : { flex: 1 };
  const buttons = () => (
    <View style={{ flexDirection: "row", gap: desktop ? 8 : 10 }}>
      <View
        onPressDown={() => add("pressIn")}
        onPressUp={() => add("pressOut")}
        onPress={() => add("press")}
        onLongPress={() => add("longPress")}
        {...button("primary", { style: share })}
        activeStyle={{ opacity: 0.5 }}
      >
        <Text style={buttonText("primary")}>activeStyle opacity</Text>
      </View>
      <View
        onPress={() => add("underlay")}
        {...button("secondary", { style: share })}
        activeStyle={{ backgroundColor: ui().border, backgroundImage: "none" }}
      >
        <Text style={buttonText()}>activeStyle background</Text>
      </View>
      <View
        onPress={() => add("active:")}
        class={
          desktop
            ? "h-8 items-center justify-center rounded-lg bg-[#0f8a55] px-3 transition motion-reduce:transition-none hover:bg-[#12a368] active:scale-95 active:bg-[#0b6b42] dark:bg-[#45d49a] dark:hover:bg-[#5be0a9] dark:active:bg-[#2fae7b]"
            : "flex-1 items-center rounded-xl bg-[#0f8a55] p-3.5 transition motion-reduce:transition-none hover:bg-[#12a368] active:scale-95 active:bg-[#0b6b42] dark:bg-[#45d49a] dark:hover:bg-[#5be0a9] dark:active:bg-[#2fae7b]"
        }
        focusStyle={focusRing()}
      >
        <Text class={desktop ? "text-[13px] font-semibold text-white dark:text-[#0c0d0f]" : "font-semibold text-white dark:text-[#0c0d0f]"}>active:</Text>
      </View>
    </View>
  );
  const slop = () => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
      <View
        hitSlop={24}
        onPress={() => dot.update((n) => n + 1)}
        style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: ui().down, margin: 12 }}
        hoverStyle={{ opacity: 0.88 }}
        focusStyle={focusRing()}
        activeStyle={{ opacity: 0.7 }}
      />
      <Text style={{ flex: 1, color: ui().text }}>
        hitSlop 24: the dot takes {desktop ? "clicks" : "taps"} around it ({dot()})
      </Text>
    </View>
  );
  const overlay = () => (
    <View style={{ height: 52 }}>
      <View
        onPress={() => under.update((n) => n + 1)}
        style={{ flex: 1, borderRadius: 12, backgroundColor: tint(ui().up, 0.14), alignItems: "center", justifyContent: "center" }}
        hoverStyle={{ opacity: 0.88 }}
        focusStyle={focusRing()}
        activeStyle={{ opacity: 0.7 }}
      >
        <Text style={{ color: ui().up }}>Under an overlay: {under()}</Text>
      </View>
      <View
        pointerEvents="none"
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 12, borderWidth: 3, borderColor: ui().warn, borderStyle: "dashed" }}
      />
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 16, paddingTop: 24, gap: 14 }}>
      {() =>
        wide() ? (
          <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 14 }}>
              {buttons()}
              <Text style={{ color: ui().muted, fontSize: 13 }}>Click, hold, or move off a button while pressing</Text>
              {slop()}
              {overlay()}
              <DragCard />
              <ResponderDot />
            </View>
            <Inspector>
              <Log title="Press events, newest first" lines={log()} minHeight={92} />
            </Inspector>
          </View>
        ) : (
          <>
            {buttons()}
            <Text style={{ color: ui().muted, fontSize: 13 }}>{log().join(" · ") || "Tap, hold, or slide off a button"}</Text>
            {slop()}
            {overlay()}
            <DragCard />
            <ResponderDot />
          </>
        )
      }
    </View>
  );
}

mount(App);
