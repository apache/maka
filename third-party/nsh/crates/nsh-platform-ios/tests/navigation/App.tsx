import { mount, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack, Input } from "nsh/base";

interface Route {
  name: string;
  headerVisible: boolean;
  popOnSwipe: boolean;
  popOnBack: boolean;
}

const root: Route = { name: "root", headerVisible: false, popOnSwipe: true, popOnBack: true };
const pages: Route[] = [
  { ...root, name: "Hidden header" },
  { ...root, name: "Visible header", headerVisible: true },
  { ...root, name: "Swipe disabled", popOnSwipe: false },
  { ...root, name: "Back disabled", popOnBack: false },
  { ...root, name: "Visible swipe disabled", headerVisible: true, popOnSwipe: false },
  { ...root, name: "Visible back disabled", headerVisible: true, popOnBack: false },
  { ...root, name: "Multiline editor" },
];

function App() {
  const nav = createNavStack<Route>([root]);
  const dismissed = signal(0);
  const down = signal(false);
  const focused = signal(false);
  const blurDuringDrag = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 64, backgroundColor: "#ffffff" }}
      onTouchStart={() => down.set(true)}
      onTouchEnd={() => down.set(false)}
      onTouchCancel={() => down.set(false)}>
      <Text>{`depth:${nav.routes().length}`}</Text>
      <Text>{`dismissed:${dismissed()}`}</Text>
      <Text>{`focused:${focused()} blurDuringDrag:${blurDuringDrag()}`}</Text>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => (
          <NavPage
            title={route.name}
            headerVisible={route.headerVisible}
            popOnSwipe={route.popOnSwipe}
            popOnBack={route.popOnBack}
            onDismiss={() => dismissed.update((n) => n + 1)}
          >
            <View style={{ flex: 1, backgroundColor: "#ffffff" }}>
              <Text>{route.name}</Text>
              <If when={route.name === "root"}>
                <Each of={pages}>
                  {(page) => (
                    <View role="button" onPress={() => nav.push(page())} style={{ height: 50 }}>
                      <Text>{page().name}</Text>
                    </View>
                  )}
                </Each>
              </If>
              <If when={route.name !== "root"}>
                <View role="button" onPress={() => nav.pop()} style={{ height: 60 }}>
                  <Text>Custom back</Text>
                </View>
              </If>
              <Input testID="editor" placeholder="Write here" multiline={route.name === "Multiline editor"} style={{ height: 44 }}
                onFocus={() => focused.set(true)}
                onBlur={() => { focused.set(false); blurDuringDrag.set(down()); }} />
              <View testID="edge" style={{ position: "absolute", left: 0, top: 200, width: 4, height: 100 }} />
              <View testID="content" style={{ position: "absolute", left: 100, top: 200, width: 4, height: 100 }} />
            </View>
          </NavPage>
        )}
      </NavStack>
    </View>
  );
}

mount(App);
