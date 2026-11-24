import { mount, platform, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";

// A drawer's content: a view whose pan opens it to the right
// (`panActivation`) around a stack with a page pushed. The drawer's pan is
// on or off (no `onPanStart`), as a drawer turns it off while a page is
// pushed so that the page's swipe back goes first.
function App() {
  const nav = createNavStack<string>(["root"]);
  const enabled = signal(false);
  const pans = signal(0);
  return (
    <View
      style={{ flex: 1 }}
      panActivation={{ direction: "right" }}
      onPanStart={enabled() ? () => pans.update((n) => n + 1) : undefined}
    >
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => (
          <NavPage title={route} headerVisible={route !== "root"}>
            <View style={{ flex: 1, padding: 16, gap: 12, backgroundColor: "#ffffff" }}>
              <Text>{`page: ${route}, depth ${nav.routes().length}`}</Text>
              <Text>{`drawer pan: ${enabled() ? "on" : "off"}, ${pans()} pans`}</Text>
              <Text>{`Platform: ${platform.os}`}</Text>
              <View role="button" testID="push" onPress={() => nav.push("second")} style={{ height: 44 }}>
                <Text>Push</Text>
              </View>
              <View
                role="button"
                testID="toggle"
                onPress={() => enabled.update((on) => !on)}
                style={{ height: 44 }}
              >
                <Text>Toggle the drawer's pan</Text>
              </View>
              <View testID="content" style={{ height: 160, backgroundColor: "#e8eef6" }} />
            </View>
          </NavPage>
        )}
      </NavStack>
    </View>
  );
}

mount(App);
