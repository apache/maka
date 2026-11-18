import { mount, Overlay, Scroll, signal, Text, View, type ScrollProps, type ViewProps } from "nsh";

/** What the focused view's `onKeyDown` / `onKeyUp` reported last: the
 * source's logical key, its DOM code, the mounted capture decision, the
 * modifiers, and whether UIKit reported a repeat. */
function App() {
  const focus = signal("none");
  const key = signal("");
  const code = signal("");
  const prevented = signal("");
  const mods = signal("");
  const repeat = signal("");
  const up = signal("");
  const upPrevented = signal("");
  const scrollKey = signal("");
  const scrollPrevented = signal("");
  const portals = signal<"none" | "a" | "b">("none");
  const hostAKey = signal("");
  const hostAPrevented = signal("");
  const hostACount = signal(0);
  const childBKey = signal("");
  const childBPrevented = signal("");
  const pressed = signal(0);

  const reported = (e: {
    key: string;
    code: string;
    defaultPrevented: boolean;
    modifiers: { control: boolean; alt: boolean; shift: boolean; platform: boolean };
    repeat: boolean;
  }) => {
    key.set(e.key);
    code.set(e.code || "-");
    prevented.set(String(e.defaultPrevented));
    repeat.set(e.repeat ? "repeat" : "once");
    const held = [
      e.modifiers.control ? "control" : "",
      e.modifiers.alt ? "alt" : "",
      e.modifiers.shift ? "shift" : "",
      e.modifiers.platform ? "platform" : "",
    ].filter(Boolean);
    mods.set(held.join("+") || "none");
  };

  const focusable = (
    name: string,
    captureKeys?: "all" | readonly string[],
    press = true,
  ): ViewProps => {
    const props: ViewProps = {
      testID: name,
      focusable: true,
      onFocus: () => focus.set(name),
      onBlur: () => focus.set("none"),
      onKeyDown: (e) => reported(e),
      onKeyUp: (e) => {
        up.set(e.key);
        upPrevented.set(String(e.defaultPrevented));
      },
    };
    if (press) {
      // A pressable view: Return and Space press it, and its own
      // PressRecognizer focuses it.
      props.onPress = () => pressed.update((n) => n + 1);
    }
    if (captureKeys) {
      props.captureKeys = captureKeys;
    }
    return props;
  };

  /** A focusable view with no press or key listeners of its own. */
  const focusOnly = (name: string): ViewProps => ({
    testID: name,
    focusable: true,
    onFocus: () => focus.set(name),
    onBlur: () => focus.set("none"),
  });

  const scrollProps: ScrollProps = {
    captureKeys: ["a"],
    onKeyDown: (e) => {
      scrollKey.set(e.key);
      scrollPrevented.set(String(e.defaultPrevented));
    },
  };

  const hostAProps: ViewProps = {
    captureKeys: ["a"],
    onKeyDown: (e) => {
      hostAKey.set(e.key);
      hostAPrevented.set(String(e.defaultPrevented));
      hostACount.update((n) => n + 1);
    },
  };

  const childAProps: ViewProps = {
    testID: "childA",
    focusable: true,
    onPress: () => {},
    onFocus: () => focus.set("childA"),
    onBlur: () => focus.set("none"),
  };

  const childBProps: ViewProps = {
    ...childAProps,
    testID: "childB",
    onFocus: () => focus.set("childB"),
    onKeyDown: (e) => {
      childBKey.set(e.key);
      childBPrevented.set(String(e.defaultPrevented));
    },
  };

  const row = { height: 32, backgroundColor: "#eeeeee", margin: 4 };

  return (
    <View style={{ flex: 1, paddingTop: 64, backgroundColor: "#ffffff" }}>
      <Text>{`focus:${focus()}`}</Text>
      <Text>{`key:${key()}`}</Text>
      <Text>{`code:${code()}`}</Text>
      <Text>{`prevented:${prevented()}`}</Text>
      <Text>{`mods:${mods()}`}</Text>
      <Text>{`repeat:${repeat()}`}</Text>
      <Text>{`up:${up()}`}</Text>
      <Text>{`upPrevented:${upPrevented()}`}</Text>
      <Text>{`scrollKey:${scrollKey()}`}</Text>
      <Text>{`scrollPrevented:${scrollPrevented()}`}</Text>
      <Text>{`hostAKey:${hostAKey()}`}</Text>
      <Text>{`hostAPrevented:${hostAPrevented()}`}</Text>
      <Text>{`hostACount:${hostACount()}`}</Text>
      <Text>{`childBKey:${childBKey()}`}</Text>
      <Text>{`childBPrevented:${childBPrevented()}`}</Text>
      <Text>{`pressed:${pressed()}`}</Text>
      <View testID="openPortalsA" focusable={false} onPress={() => portals.set("a")} style={row}>
        <Text>open portal A</Text>
      </View>
      <View testID="openPortalsB" focusable={false} onPress={() => portals.set("b")} style={row}>
        <Text>open portal B</Text>
      </View>
      <View {...focusable("first")} style={row}>
        <Text>first</Text>
      </View>
      <View {...focusable("second", ["a"])} style={row}>
        <Text>second</Text>
      </View>
      <View {...focusable("third")} style={row}>
        <Text>third</Text>
      </View>
      <View {...focusable("capturedTab", ["tab"])} style={row}>
        <Text>captured tab</Text>
      </View>
      <View {...focusable("noPress", undefined, false)} style={row}>
        <Text>no press</Text>
      </View>
      <Scroll testID="scrollAncestor" style={{ height: 80, margin: 8 }} {...scrollProps}>
        <View {...focusOnly("scrollChild")} style={{ height: 48, backgroundColor: "#dddddd" }}>
          <Text>scroll child</Text>
        </View>
      </Scroll>
      <View testID="hostA" style={{ height: 1 }} {...hostAProps}>
        {portals() === "a" ? (
          <Overlay style={{ top: 140, left: 8, width: 150, height: 70 }}>
            <View {...childAProps} style={{ height: 40 }}>
              <Text>child A</Text>
            </View>
          </Overlay>
        ) : null}
      </View>
      <View testID="hostB" style={{ height: 1 }}>
        {portals() === "b" ? (
          <Overlay style={{ top: 140, left: 200, width: 150, height: 70 }}>
            <View {...childBProps} style={{ height: 40 }}>
              <Text>child B</Text>
            </View>
          </Overlay>
        ) : null}
      </View>
    </View>
  );
}

mount(App);
