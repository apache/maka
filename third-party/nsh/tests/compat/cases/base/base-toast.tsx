// A case of the API's test suite (docs/dev/compatibility.md): the toast
// primitives of `nsh/base` on a phone: a `ToastManager` (push, replace by
// id, dismiss, dismissAll, advance with its timeouts and phases, visible
// with a limit, entries, get, len, isEmpty) driven by the app's timer, its
// toasts rendered as `Toast`s (their `transitionStatus` and the states'
// classes, the screen reader's label, a swipe asking to dismiss) in a
// `ToastStack` anchored to the bottom, then the top (its motion, its layers,
// a finger expanding it). Its script checks each.
import { Text, View, signal } from "nsh";
import { Toast, type ToastEntry, ToastManager, ToastStack } from "nsh/base";

const motion = { duration: 100, exitDuration: 100, collapsedPeek: 10, expandedGap: 6, collapsedScaleStep: 0.1, collapsedVisible: 2 };

function App() {
  const manager = new ToastManager(motion);
  const shown = signal<ToastEntry[]>([]);
  const log = signal("Log: none");
  const expanded = signal(false);
  const placement = signal<"bottomCenter" | "topCenter">("bottomCenter");
  const sync = () => shown.set(manager.visible(2));
  setInterval(() => {
    const a = manager.advance(expanded());
    if (a.presented.length) log.set(`Log: presented ${a.presented.join(",")}`);
    if (a.ending.length) log.set(`Log: ending ${a.ending.join(",")}`);
    if (a.removed.length) log.set(`Log: removed ${a.removed.map((r) => r.id).join(",")}`);
    if (a.changed) sync();
  }, 20);
  const push = (id: string, title: string, timeout?: number) => {
    const replaced = manager.push(id, { title }, { timeout });
    log.set(`Log: pushed ${id} replaced ${replaced ? (replaced as { title: string }).title : "none"}`);
    sync();
  };
  return (
    <View style={{ flex: 1, paddingTop: 60, paddingLeft: 20, gap: 8 }}>
      <Text>{log()}</Text>
      <Text>{`Count: ${shown().length} ${manager.len()} ${manager.isEmpty()} ${expanded()}`}</Text>
      <View onPress={() => push("a", "TitleA")}><Text>PushA</Text></View>
      <View onPress={() => push("b", "TitleB", 300)}><Text>PushB</Text></View>
      <View onPress={() => push("c", "TitleC")}><Text>PushC</Text></View>
      <View onPress={() => push("a", "TitleA2")}><Text>ReplaceA</Text></View>
      <View onPress={() => { log.set(`Log: dismissed ${manager.dismissAll().join(",")}`); sync(); }}><Text>DismissAll</Text></View>
      <View onPress={() => placement.set("topCenter")}><Text>AnchorTop</Text></View>
      <View onPress={() => log.set(`Log: entries ${manager.entries().map((e) => `${e.id}=${e.status}`).join(",")} get ${(manager.get("a") as { title: string } | null)?.title}`)}>
        <Text>Inspect</Text>
      </View>
      <View style={{ position: "absolute", left: 20, top: 500, width: 200 }}>
        <ToastStack
          motion={motion}
          placement={placement()}
          closeOnEscape
          style={{ width: 200 }}
          onExpandedChange={(open) => expanded.set(open)}
          onCancel={() => log.set("Log: stack cancel")}
        >
          <Each of={shown()} key={(e: ToastEntry) => e.id}>
            {(entry) => (
              <Toast
                transitionStatus={entry().status}
                accessibilityLabel={(entry().value as { title: string }).title}
                swipeDirection="left"
                swipeThreshold={40}
                startingClass="opacity-50"
                endingClass="opacity-25"
                swipingClass="bg-[#00ff00]"
                class="bg-[#123456]"
                style={{ height: 30 }}
                onDismissRequest={() => {
                  manager.dismiss(entry().id);
                  log.set(`Log: swiped ${entry().id}`);
                  sync();
                }}
              >
                <Text>{(entry().value as { title: string }).title}</Text>
              </Toast>
            )}
          </Each>
        </ToastStack>
      </View>
    </View>
  );
}

export default App;
