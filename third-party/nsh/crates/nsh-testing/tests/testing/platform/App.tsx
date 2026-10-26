// What a platform does besides drawing, as headless runs play it: going
// back, dialogs, the clipboard, native animations, a dialog, and images
// that never load.
import { Image, mount, signal, Text, View } from "nsh";
import { Animated, createAnimatedValue } from "nsh";
import { Clipboard } from "nsh";
import { AlertDialog, createNavStack, Dialog, NavPage, NavStack } from "nsh/base";

type Route = { name: "home" } | { name: "detail" } | { name: "draft" };
const nav = createNavStack<Route>([{ name: "home" }]);

function Press(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress}>
      <Text>{props.label}</Text>
    </View>
  );
}

function Home() {
  const answer = signal("none");
  const pasted = signal("");
  const moved = signal("still");
  const measured = signal("unmeasured");
  const sheet = signal(false);
  const shown = signal(0);
  const x = createAnimatedValue(0);
  return (
    <NavPage title="Home">
      <View style={{ flex: 1 }}>
        <Text>{`Answer: ${answer()}`}</Text>
        <Text>{`Pasted: ${pasted()}`}</Text>
        <Text>{`Moved: ${moved()}`}</Text>
        <Text>{`Shown: ${shown()}`}</Text>
        <Press label="Open" onPress={() => nav.push({ name: "detail" })} />
        <Press label="Draft" onPress={() => nav.push({ name: "draft" })} />
        <Press
          label="Delete"
          onPress={async () => {
            const chosen = await AlertDialog.show({
              title: "Delete?",
              description: "It is gone after.",
              actions: [
                { label: "Cancel", role: "cancel" },
                { label: "Delete", role: "destructive" },
              ],
            });
            answer.set(chosen ?? "dismissed");
          }}
        />
        <Press
          label="Update"
          onPress={async () => {
            const chosen = await AlertDialog.show({
              title: "Update",
              description: "Install it now?",
              actions: [{ label: "Later" }, { label: "Install" }],
            });
            answer.set(chosen ?? "dismissed");
          }}
        />
        <Press label="Copy" onPress={() => Clipboard.writeText("copied text")} />
        <Press label="Paste" onPress={async () => pasted.set(await Clipboard.readText())} />
        <Press label="Move" onPress={() => Animated.timing(x, { toValue: 100, duration: 300 }).start(() => moved.set("done"))} />
        <Press
          label="Measure"
          onPress={() =>
            Image.getSize("https://example.com/a.png").then(
              () => measured.set("measured"),
              () => measured.set("not loaded"),
            )
          }
        />
        <Text>{`Size: ${measured()}`}</Text>
        <Press label="Sheet" onPress={() => sheet.set(true)} />
        <Dialog open={sheet()} onOpenChange={(open) => sheet.set(open)} onOpen={() => shown.set(shown() + 1)}>
          <Text>In the sheet</Text>
        </Dialog>
      </View>
    </NavPage>
  );
}

function Draft() {
  const asked = signal(false);
  return (
    <NavPage title="Draft" popOnBack={false} onBackPress={() => asked.set(true)}>
      <Text>{`Asked: ${asked() ? "yes" : "no"}`}</Text>
    </NavPage>
  );
}

function App() {
  return (
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) =>
        route.name === "home" ? (
          <Home />
        ) : route.name === "draft" ? (
          <Draft />
        ) : (
          <NavPage title="Detail">
            <Text>Detail body</Text>
          </NavPage>
        )
      }
    </NavStack>
  );
}

mount(App);
