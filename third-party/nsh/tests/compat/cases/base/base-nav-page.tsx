// A case of the API's test suite (docs/dev/compatibility.md): the options
// of a `NavPage` of `nsh/base` as the platform receives them (the page's
// defaults, every header option set, `headerStyle` winning over
// `headerClass`, props following signals), its header slots (`header`,
// `headerLeft`, `headerRight`, `headerTitle`, shown and removed), and its
// events as a platform reports them: `onBackPress` (the page stays: the
// platform pops it natively when `popOnBack` lets it), and `onDismiss`
// (the user popped it: its route leaves the state, then the app hears).
// Pages carry a `testID` (spread, as `NavPage` declares none) for the
// script to find them. The pages that open last keep the user
// (`popOnBack={false}`). Its script checks
// each.
import { Text, View, signal } from "nsh";
import { Button, NavPage, NavStack, createNavStack } from "nsh/base";

const nav = createNavStack<string>(["first"]);

const title = signal("First title");
const keep = signal(false);
const right = signal(true);
const backs = signal(0);
const dismissed = signal("none");

function First() {
  return (
    <NavPage {...{ testID: "first" }} title={title()} headerClass="bg-[#112233] text-[#445566] tint-[#778899]">
      <Text>First content</Text>
    </NavPage>
  );
}

function Second() {
  return (
    <NavPage
      {...{ testID: "second" }}
      title="Second title"
      headerVisible={false}
      headerLargeTitle
      headerTransparent
      headerBackTitle="Back to second"
      headerBackVisible={false}
      popOnSwipe={false}
      popOnBack={!keep()}
      animation="fade"
      headerClass="bg-[#112233] text-[#445566]"
      headerStyle={{ backgroundColor: "#00ff00", color: "#ff0000", tintColor: "#0000ff" }}
      header={<Text>Desktop header</Text>}
      headerLeft={<Text>Left item</Text>}
      headerRight={right() ? <Text>Right item</Text> : null}
      ios={{ headerRightSystemItem: "add" }}
      headerTitle={<Text>Title item</Text>}
      onBackPress={() => backs.set(backs() + 1)}
      onDismiss={() => dismissed.set(`second, routes ${nav.routes().join(" > ")}`)}
      style={{ padding: 10 }}
    >
      <View {...{ testID: "second-content" }} style={{ height: 40 }}>
        <Text>Second content</Text>
      </View>
    </NavPage>
  );
}

function Third(props: { animation: "none" | "slide" | "default" }) {
  return (
    <NavPage {...{ testID: `third-${props.animation}` }} animation={props.animation} popOnBack={false}>
      <Text>{`Third ${props.animation}`}</Text>
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
      <Text>{`Routes: ${nav.routes().join(" > ")}`}</Text>
      <Text>{`Backs: ${backs()}`}</Text>
      <Text>{`Dismissed: ${dismissed()}`}</Text>
      <Control label="Open second" onPress={() => nav.push("second")} />
      <Control label="Open thirds" onPress={() => (nav.push("none"), nav.push("slide"), nav.push("default"))} />
      <Control label="Rename" onPress={() => title.set("Renamed")} />
      <Control label="Keep" onPress={() => keep.set(!keep())} />
      <Control label="Toggle right" onPress={() => right.set(!right())} />
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => {
          if (route === "first") return <First />;
          if (route === "second") return <Second />;
          return <Third animation={route as "none" | "slide" | "default"} />;
        }}
      </NavStack>
    </View>
  );
}

export default App;
