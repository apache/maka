// A case of the API's test suite (docs/dev/compatibility.md): the state of
// a `NavStack` of `nsh/base` (`createNavStack`) driven through every
// member: `push` (the same route twice is two pages), `pop` with and
// without a count (one page always stays), `popToRoot`, `replace`,
// `setRoutes` and `remove` (the topmost page of a route), `routes` read
// back reactively, each page's `index` following the pages below it, the
// render function running once per push, a page keeping its state while
// covered and its cleanups running when its route leaves. A route that
// renders no `NavPage` is wrapped in a page. The controls sit outside the
// stack, whose top page is on screen; a covered page's state is checked
// once it is on top again. Its script checks each.
import { type Accessor, Text, View, cleanup, signal } from "nsh";
import { Button, NavPage, NavStack, createNavStack } from "nsh/base";

type Route = { name: string };

const home: Route = { name: "home" };
const twice: Route = { name: "twice" };
const nav = createNavStack<Route>([home]);

const renders = signal(0);
const cleanups = signal<string[]>([]);
let pushed = 0;

function Page(props: { route: Route; at: Accessor<number> }) {
  const bumps = signal(0);
  cleanup(() => cleanups.set([...cleanups(), props.route.name]));
  return (
    <NavPage title={`Title ${props.route.name}`}>
      <View style={{ flex: 1 }}>
        <Text>{`Page ${props.route.name} at ${props.at()}`}</Text>
        <Text>{`Bumps of ${props.route.name}: ${bumps()}`}</Text>
        <Button onPress={() => bumps.set(bumps() + 1)}>
          <Text>{`Bump ${props.route.name}`}</Text>
        </Button>
      </View>
    </NavPage>
  );
}

function Control(props: { label: string; onPress: () => void }) {
  return (
    <Button onPress={props.onPress}>
      <Text>{props.label}</Text>
    </Button>
  );
}

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <Text>{`Routes: ${nav.routes().map((r) => r.name).join(" > ")}`}</Text>
      <Text>{`Depth: ${nav.routes().length}`}</Text>
      <Text>{`Renders: ${renders()}`}</Text>
      <Text>{`Cleanups: ${[...cleanups()].sort().join(" ") || "none"}`}</Text>
      <Control label="Push" onPress={() => nav.push({ name: `p${++pushed}` })} />
      <Control label="Push twice" onPress={() => (nav.push(twice), nav.push(twice))} />
      <Control label="Push plain" onPress={() => nav.push({ name: "plain" })} />
      <Control label="Pop" onPress={() => nav.pop()} />
      <Control label="Pop two" onPress={() => nav.pop(2)} />
      <Control label="Pop many" onPress={() => nav.pop(99)} />
      <Control label="Pop to root" onPress={() => nav.popToRoot()} />
      <Control label="Replace" onPress={() => nav.replace({ name: "swapped" })} />
      <Control label="Set routes" onPress={() => nav.setRoutes([home, { name: "a" }, { name: "b" }])} />
      <Control label="Remove twice" onPress={() => nav.remove(twice)} />
      <Control label="Remove second" onPress={() => nav.remove(nav.routes()[1])} />
      <Control label="Remove unknown" onPress={() => nav.remove({ name: "unknown" })} />
      <NavStack state={nav} style={{ height: 300 }} {...{ testID: "stack" }}>
        {(route, index) => {
          renders.set(renders() + 1);
          if (route.name === "plain") {
            return <Text>{`Plain page at ${index()}`}</Text>;
          }
          return <Page route={route} at={index} />;
        }}
      </NavStack>
    </View>
  );
}

export default App;
