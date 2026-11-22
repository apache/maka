// A case of the API's test suite (docs/dev/compatibility.md): the status
// bar the platform is told to show, in layers. nsh.json's `statusBar` is
// the app's default (the bundler hands it to `nsh:rt`'s `setup`); each
// `NavPage` and `Dialog` with `statusBar` is a layer over it while it is in
// the tree, the latest winning field by field: the root page sets none
// (nsh.json's default shows), a pushed page only `foreground` (`hidden`
// comes from nsh.json), the next only `hidden` (the page below's
// `foreground` stays), a dialog `foreground` and `animated`. Popping the
// pages and closing the dialog take their layers away. Its
// script checks each.
import { Text, View, signal } from "nsh";
import { Button, Dialog, NavPage, NavStack, createNavStack } from "nsh/base";

const nav = createNavStack<string>(["plain"]);
const dialog = signal(false);

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
      <Control label="Push first" onPress={() => nav.push("first")} />
      <Control label="Push second" onPress={() => nav.push("second")} />
      <Control label="Pop" onPress={() => nav.pop()} />
      <Control label="Open dialog" onPress={() => dialog.set(true)} />
      <Control label="Close dialog" onPress={() => dialog.set(false)} />
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) =>
          route === "plain" ? (
            <NavPage title="Plain">
              <Text>Plain page</Text>
            </NavPage>
          ) : route === "first" ? (
            <NavPage title="First" statusBar={{ foreground: "light" }}>
              <Text>First page</Text>
            </NavPage>
          ) : (
            <NavPage title="Second" statusBar={{ hidden: false }}>
              <Text>Second page</Text>
            </NavPage>
          )
        }
      </NavStack>
      <Dialog open={dialog()} statusBar={{ foreground: "auto", animated: true }}>
        <Text>Dialog content</Text>
      </Dialog>
    </View>
  );
}

export default App;
