import { mount, signal, Text, View, type ViewRef } from "nsh";
import { Popover } from "nsh/base";

// A popover that takes the keyboard focus when it opens, as a non-modal
// dialog does: `onOpen` comes once its content is there, so the panel's
// ref focuses it.
function App() {
  const log = signal("focus");
  const note = (what: string) => log.set(`${log()} ${what}`);
  let panel!: ViewRef;
  return (
    <View style={{ flex: 1, paddingTop: 100, paddingLeft: 40 }}>
      <Popover
        onOpen={() => panel.focus()}
        trigger={
          <View focusable onFocus={() => note("trigger")} style={{ width: 100, height: 30 }}>
            <Text>Details</Text>
          </View>
        }
      >
        <View ref={panel} focusable onFocus={() => note("panel")} style={{ height: 30 }}>
          <Text>Panel</Text>
        </View>
      </Popover>
      <Text>{log()}</Text>
    </View>
  );
}

mount(App);
