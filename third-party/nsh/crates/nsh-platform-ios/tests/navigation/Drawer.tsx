import { Animated, createAnimatedValue, Easing, mount, safeAreaInsets, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";

/** How far the drawer moves the stack aside, and how much it shrinks it. */
const SHIFT = 280;
const SHRINK = 0.86;
const CELLS = [0, 1, 2, 3, 4];

function Button(props: { label: string; onPress: () => void }) {
  return (
    <View role="button" onPress={props.onPress} style={{ height: 44, justifyContent: "center", paddingHorizontal: 12 }}>
      <Text style={{ color: "#ffffff" }}>{props.label}</Text>
    </View>
  );
}

/** A push drawer: opening it moves the stack aside and shrinks it (a
 * transform around the stack); its buttons change the page's header while
 * the stack is transformed, then close it. */
function App() {
  const nav = createNavStack(["Home"]);
  const insets = safeAreaInsets();
  const title = signal("Home");
  const filters = signal(false);
  const presses = signal(0);
  const cells = signal(0);
  const progress = createAnimatedValue(0);
  const open = signal(false);
  const move = (to: boolean) => {
    open.set(to);
    Animated.timing(progress, { toValue: to ? 1 : 0, duration: 250, easing: Easing.out(Easing.cubic) }).start();
  };
  return (
    <View style={{ flex: 1, backgroundColor: "#1c1c1e" }}>
      <View style={{ position: "absolute", top: insets().top, bottom: 0, left: 0, width: SHIFT, padding: 12, gap: 4 }}>
        <Button
          label="Show results"
          onPress={() => {
            title.set("Results");
            filters.set(true);
            move(false);
          }}
        />
        <Button
          label="Show home"
          onPress={() => {
            title.set("Home");
            filters.set(false);
            move(false);
          }}
        />
        <Button label="Close drawer" onPress={() => move(false)} />
      </View>
      <View
        style={{
          flex: 1,
          overflow: "hidden",
          translate: [progress.interpolate({ inputRange: [0, 1], outputRange: [0, SHIFT] }), 0],
          scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, SHRINK] }),
        }}
      >
        <NavStack state={nav} style={{ flex: 1 }}>
          {() => (
            <NavPage
              title={title()}
              headerLeft={<View role="button" accessibilityLabel="Menu" onPress={() => move(!open())} style={{ width: 32, height: 32 }} />}
              ios={{
                headerLeftSymbol: "line.3.horizontal",
                headerRightItems: [
                  { key: "search", symbol: "magnifyingglass", label: "Header search", onPress: () => presses.set(presses() + 1) },
                  ...(filters()
                    ? [{ key: "filter", symbol: "line.3.horizontal.decrease", label: "Header filter", onPress: () => presses.set(presses() + 1) }]
                    : []),
                ],
              }}
            >
              <View style={{ flex: 1, backgroundColor: "#ffffff" }}>
                {/* Cells across the page, where the header's buttons land when UIKit places the device's side bar from the transformed picture of the stack: clear of the window's side insets, the bar in its place covers none of them. */}
                <View style={{ flexDirection: "row", height: 160, marginTop: 50, marginLeft: insets().left, marginRight: insets().right }}>
                  {CELLS.map((n) => (
                    <View testID={`cell-${n}`} role="button" onPress={() => cells.set(cells() + 1)} style={{ flex: 1, backgroundColor: n % 2 ? "#e5e5ea" : "#d1d1d6" }} />
                  ))}
                </View>
                <View style={{ padding: 12, gap: 8 }}>
                  <Text>{`Page: ${title()}`}</Text>
                  <Text>{`Header presses: ${presses()}`}</Text>
                  <Text>{`Cell presses: ${cells()}`}</Text>
                  <Text>{`Drawer: ${open() ? "open" : "closed"}`}</Text>
                </View>
              </View>
            </NavPage>
          )}
        </NavStack>
      </View>
    </View>
  );
}

mount(App);
