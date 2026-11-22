// Native iOS regression fixture: use real XCTest edge swipes, not the test
// agent's in-process touches (docs/dev/pitfalls.md, "iOS, the test agent's input").
import { mount, signal, Text, View } from "nsh";
import { Button, createNavStack, NavPage, NavStack } from "nsh/base";

type Route = "root" | "swipe" | "locked" | "prevented";

function App() {
  const nav = createNavStack<Route>(["root"]);
  const dismissed = signal(0);
  const control = (label: string, action: () => void) => (
    <Button onPress={action} accessibilityLabel={label} style={{ minHeight: 44 }}>
      <Text style={{ color: "#111" }}>{label}</Text>
    </Button>
  );
  return (
    <View style={{ flex: 1, backgroundColor: "white", paddingTop: "env(safe-area-inset-top)", paddingRight: "env(safe-area-inset-right)", paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "env(safe-area-inset-left)" }}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => (
          <NavPage
            title={route}
            headerVisible={false}
            popOnSwipe={route !== "locked"}
            popOnBack={route !== "prevented"}
            onDismiss={() => dismissed.set(dismissed() + 1)}
          >
            <View style={{ flex: 1, padding: 16, gap: 12 }}>
              <Text style={{ color: "#111" }}>{`Page: ${route}`}</Text>
              <Text style={{ color: "#111" }}>{`Dismissed: ${dismissed()}`}</Text>
              {route === "root" ? (
                <View style={{ gap: 12 }}>
                  {control("Open swipe page", () => nav.push("swipe"))}
                  {control("Open locked page", () => nav.push("locked"))}
                  {control("Open prevented page", () => nav.push("prevented"))}
                </View>
              ) : control("Inline back", () => nav.pop())}
            </View>
          </NavPage>
        )}
      </NavStack>
    </View>
  );
}

mount(App);
