// The end-to-end jank benchmark's app (`jank.py`): a window whose first frame is timed, a recycled list of
// 10,000 rows to scroll, and three looping animations that run the whole time.
import { Animated, createAnimatedValue, Easing, List, mount, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { STALL_MS } from "./stall";

if (STALL_MS > 0) {
  const end = Date.now() + STALL_MS;
  while (Date.now() < end) {}
}

const rows = Array.from({ length: 10_000 }, (_, i) => i);

function Spinner() {
  const spin = createAnimatedValue(0);
  const pulse = createAnimatedValue(0);
  Animated.parallel([
    Animated.loop(Animated.timing(spin, { toValue: 360, duration: 1200, easing: Easing.linear }), {
      resetBeforeIteration: true,
    }),
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.sin) }),
        Animated.timing(pulse, { toValue: 0, duration: 600, easing: Easing.inOut(Easing.sin) }),
      ]),
    ),
  ]).start();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16, padding: 16 }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          borderWidth: 3,
          borderColor: "#3b82f6",
          borderTopColor: "transparent",
          rotate: spin,
        }}
      />
      <View
        style={{
          width: 120,
          height: 12,
          borderRadius: 6,
          backgroundColor: "#22c55e",
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
          scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }),
        }}
      />
      <Text>Jank bench</Text>
    </View>
  );
}

mount(() => (
  <Window id="main" title="Jank bench">
    {() => (
      <View style={{ flex: 1 }}>
        <Spinner />
        <List id="list" each={rows} estimatedItemSize={44} style={{ flex: 1 }}>
          {(i) => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, height: 44 }}>
              <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: i() % 2 ? "#e5e7eb" : "#bfdbfe" }} />
              <Text style={{ flex: 1 }}>{`Row ${i()}`}</Text>
              <Text style={{ color: "#6b7280" }}>{`${(i() * 37) % 1000} items`}</Text>
            </View>
          )}
        </List>
      </View>
    )}
  </Window>
));
