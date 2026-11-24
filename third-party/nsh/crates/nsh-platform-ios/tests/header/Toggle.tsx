import { mount, safeAreaInsets, type Signal, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";

interface Route {
  name: string;
  /** The page's `headerVisible`, which `Toggle` changes while the page is
   * on top. */
  visible: Signal<boolean>;
}

const route = (name: string, visible: boolean): Route => ({ name, visible: signal(visible) });

/** A page's content and where it rests: the top inset of the page (what
 * UIKit draws over the top of its content) and the height it got. */
function Content(props: { name: string }) {
  const insets = safeAreaInsets();
  const height = signal<number | undefined>(undefined);
  return (
    <View style={{ flex: 1 }} onLayout={(e) => height.set(Math.round(e.bounds.size.height))}>
      <Text>{`${props.name} top:${Math.round(insets().top)} height:${height() ?? "none"}`}</Text>
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
  const nav = createNavStack<Route>([route("Root", true)]);
  // Pressed in the bar UIKit shows: found only while the bar is on screen.
  const presses = signal(0);
  const toggle = () => {
    const top = nav.routes().at(-1);
    top?.visible.set(!top.visible());
  };
  return (
    <View style={{ flex: 1 }}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(r) => (
          <NavPage
            title={r.name}
            headerVisible={r.visible()}
            ios={{
              headerRightItems: [
                { key: "add", symbol: "plus", label: "Header add", onPress: () => presses.set(presses() + 1) },
              ],
            }}
          >
            <Content name={r.name} />
            <Text>{`Header presses: ${presses()}`}</Text>
          </NavPage>
        )}
      </NavStack>
      <View style={{ flexDirection: "row", paddingBottom: 34 }}>
        <Button label="Push hidden" onPress={() => nav.push(route("Hidden", false))} />
        <Button label="Pop" onPress={() => nav.pop()} />
        <Button label="Toggle" onPress={toggle} />
      </View>
    </View>
  );
}

mount(App);
