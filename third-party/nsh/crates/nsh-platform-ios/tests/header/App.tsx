import { mount, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";

interface Route {
  name: string;
  headerVisible: boolean;
}

/** A page's content, and how much of the page it got: the page's height
 * less its header. */
function Content(props: { name: string }) {
  const height = signal<number | undefined>(undefined);
  return (
    <View style={{ flex: 1 }} onLayout={(e) => height.set(Math.round(e.bounds.size.height))}>
      <Text>{`${props.name} height:${height() ?? "none"}`}</Text>
    </View>
  );
}

function Button(props: { label: string; onPress: () => void }) {
  return (
    <View role="button" onPress={props.onPress} style={{ height: 44, justifyContent: "center", paddingHorizontal: 12 }}>
      <Text>{props.label}</Text>
    </View>
  );
}

function App() {
  // The stack starts below the status bar, as in an app that keeps its
  // whole root clear of the safe area.
  const nav = createNavStack<Route>([{ name: "Root", headerVisible: true }]);
  return (
    <View style={{ flex: 1, paddingTop: "env(safe-area-inset-top)" }}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => (
          <NavPage title={route.name} headerVisible={route.headerVisible}>
            <Content name={route.name} />
          </NavPage>
        )}
      </NavStack>
      <View style={{ flexDirection: "row", paddingBottom: 34 }}>
        <Button label="Push hidden" onPress={() => nav.push({ name: "Hidden", headerVisible: false })} />
        <Button label="Push visible" onPress={() => nav.push({ name: "Visible", headerVisible: true })} />
        <Button label="Pop" onPress={() => nav.pop()} />
      </View>
    </View>
  );
}

mount(App);
