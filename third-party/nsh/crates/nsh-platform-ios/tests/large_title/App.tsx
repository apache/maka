import { mount, safeAreaInsets, Scroll, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";

interface Route {
  name: string;
  /** Its content and its title arrive after the page is shown (a record
   * that loads). */
  late?: boolean;
}

const rows = Array.from({ length: 30 }, (_, i) => i + 1);

/** A scroll view under the page's large title, and where it rests: the
 * top inset of the page (below its header) and the scroll view's offset. */
function Rows(props: { name: string }) {
  const insets = safeAreaInsets();
  const offset = signal<number | undefined>(undefined);
  return (
    <View style={{ flex: 1 }}>
      <Scroll style={{ flex: 1 }} onScroll={(e) => offset.set(Math.round(e.offset.y))}>
        <Each of={rows}>
          {(n) => (
            <View style={{ height: 44, justifyContent: "center", paddingHorizontal: 16 }}>
              <Text>{`Row ${n()}`}</Text>
            </View>
          )}
        </Each>
      </Scroll>
      <Text>{`${props.name} top:${Math.round(insets().top)} offset:${offset() ?? "none"}`}</Text>
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
  // The stack and its first page arrive in the same frame.
  const nav = createNavStack<Route>([{ name: "Root" }]);
  const plain = signal(false);
  return (
    <View style={{ flex: 1 }}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => {
          const loaded = signal(!route.late);
          if (route.late) setTimeout(() => loaded.set(true), 300);
          // The same page, plain and then large again (`Toggle`): a header
          // changed in place, over a new scroll view.
          const large = () => !plain();
          return (
            <NavPage title={loaded() ? route.name : "Loading"} headerLargeTitle={large()}>
              <If when={large() && loaded()} else={<View style={{ flex: 1 }} />}>
                <Rows name={route.name} />
              </If>
            </NavPage>
          );
        }}
      </NavStack>
      <View style={{ flexDirection: "row", flexWrap: "wrap", paddingBottom: 34 }}>
        <Button label="Push" onPress={() => nav.push({ name: "Pushed" })} />
        <Button label="Pop" onPress={() => nav.pop()} />
        <Button label="Replace" onPress={() => nav.setRoutes([{ name: "Replaced", late: true }])} />
        <Button label="Toggle" onPress={() => plain.set(!plain())} />
      </View>
    </View>
  );
}

mount(App);
