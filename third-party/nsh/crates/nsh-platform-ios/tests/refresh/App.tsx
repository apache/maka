import { List, mount, Scroll, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";

type Kind = "scroll" | "list";

interface Route {
  name: string;
  kind?: Kind;
  largeTitle: boolean;
}

const pages: Route[] = [
  { name: "Large scroll", kind: "scroll", largeTitle: true },
  { name: "Large list", kind: "list", largeTitle: true },
  { name: "Plain scroll", kind: "scroll", largeTitle: false },
  { name: "Plain list", kind: "list", largeTitle: false },
];

const rows = Array.from({ length: 30 }, (_, i) => i + 1);

function Row(props: { n: number }) {
  return (
    <View style={{ height: 48, justifyContent: "center", paddingHorizontal: 16 }}>
      <Text>{`Row ${props.n}`}</Text>
    </View>
  );
}

function Button(props: { label: string; onPress: () => void }) {
  return (
    <View role="button" onPress={props.onPress} style={{ height: 44, justifyContent: "center", paddingHorizontal: 16 }}>
      <Text>{props.label}</Text>
    </View>
  );
}

/** A refreshable scroll view or list under the page's header, the refreshes
 * it reported, and buttons that end a refresh, take the view away and bring
 * it back (a new view and a new refresh control), and take `onRefresh` off
 * the same view and put it back (the same view, a new refresh control). */
function Refreshable(props: { kind: Kind }) {
  const refreshes = signal(0);
  const refreshing = signal(false);
  const shown = signal(true);
  const enabled = signal(true);
  const pulled = () => {
    refreshes.update((n) => n + 1);
    refreshing.set(true);
  };
  const refresh = () => (enabled() ? pulled : undefined);
  return (
    <View style={{ flex: 1 }}>
      <If
        when={shown()}
        else={<View style={{ flex: 1 }} />}
      >
        <If
          when={props.kind === "list"}
          else={
            <Scroll testID="target" style={{ flex: 1 }} refreshing={refreshing()} onRefresh={refresh()}>
              <Each of={rows}>{(n) => <Row n={n()} />}</Each>
            </Scroll>
          }
        >
          <List testID="target" each={rows} estimatedItemSize={48} style={{ flex: 1 }} refreshing={refreshing()} onRefresh={refresh()}>
            {(n) => <Row n={n()} />}
          </List>
        </If>
      </If>
      <View style={{ paddingBottom: 34 }}>
        <Text>{`refreshes:${refreshes()} refreshing:${refreshing()}`}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          <Button label="End" onPress={() => refreshing.set(false)} />
          <Button label="Remove" onPress={() => { refreshing.set(false); shown.set(false); }} />
          <Button label="Restore" onPress={() => shown.set(true)} />
          <Button label="Disable" onPress={() => { refreshing.set(false); enabled.set(false); }} />
          <Button label="Enable" onPress={() => enabled.set(true)} />
        </View>
      </View>
    </View>
  );
}

function App() {
  const nav = createNavStack<Route>([{ name: "Refresh", largeTitle: false }]);
  return (
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (
        <NavPage title={route.name} headerLargeTitle={route.largeTitle} headerTransparent={route.largeTitle}>
          <If
            when={route.kind}
            else={
              <View style={{ flex: 1, paddingTop: 120 }}>
                <Each of={pages}>{(page) => <Button label={page().name} onPress={() => nav.push(page())} />}</Each>
              </View>
            }
          >
            <Refreshable kind={route.kind!} />
          </If>
        </NavPage>
      )}
    </NavStack>
  );
}

mount(App);
