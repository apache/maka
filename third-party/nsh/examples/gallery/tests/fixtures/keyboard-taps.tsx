import { keyboardFrame, mount, Scroll, signal, Text, View, WebView } from "nsh";
import { ContextMenu, Input, MenuItem } from "nsh/base";

// Its button covers the page: any tap on the web view clicks it.
const PAGE = `<!doctype html><body style="margin:0"><button style="width:100vw;height:100vh" onclick="window.nsh.postMessage('clicked')">Web</button><script>window.nsh.postMessage('ready')</script></body>`;

function App() {
  const presses = signal(0);
  const held = signal(0);
  const drags = signal(0);
  const released = signal(0);
  const web = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 80, paddingHorizontal: 24 }}>
      <Text>{keyboardFrame().height > 0 ? "keyboard: up" : "keyboard: down"}</Text>
      <Text>{`drags: ${drags()}, web: ${web()}`}</Text>
      {/* Short enough that the keyboard leaves the field where it is: the rows stay on screen. */}
      <Scroll style={{ height: 400 }} onScrollDragStart={() => drags.set(drags() + 1)}>
        <View style={{ height: 30 }} />
        <View role="button" onPress={() => presses.set(presses() + 1)} style={{ height: 60, justifyContent: "center", padding: 16 }}>
          <Text>{`Row 1, pressed ${presses()}`}</Text>
        </View>
        <ContextMenu
          trigger={
            <View role="button" onPress={() => presses.set(presses() + 1)} style={{ height: 60, justifyContent: "center", padding: 16 }}>
              <Text>Row 2</Text>
            </View>
          }
        >
          <MenuItem>
            <Text>menu-row</Text>
          </MenuItem>
        </ContextMenu>
        <View role="button" onPress={() => presses.set(presses() + 1)} onLongPress={() => held.set(held() + 1)} style={{ height: 60, justifyContent: "center", padding: 16 }}>
          <Text>{`Row 3, held ${held()}`}</Text>
        </View>
        <View testID="responder" onStartShouldSetResponder={() => true} onResponderRelease={() => released.set(released() + 1)} style={{ height: 60, justifyContent: "center", padding: 16 }}>
          <Text>{`Row 4, released ${released()}`}</Text>
        </View>
        <WebView testID="web" html={PAGE} onMessage={(e) => web.set(e.data)} style={{ height: 60 }} />
        <View style={{ height: 1600 }} />
      </Scroll>
      <Input testID="message" placeholder="Message" style={{ height: 40, margin: 12 }} />
    </View>
  );
}

mount(App);
