import { mount, platform, Scroll, signal, Text, View } from "nsh";

// A chat: a list filling the screen and a composer card over its bottom
// that a drag down moves (`panActivation` and responder moves); in the list,
// a chart that scrubs sideways, and one in a card that opens on press.
function App() {
  const offset = signal(0);
  const card = signal(0);
  const opened = signal(false);
  const scrubbed = signal(false);
  let startY = 0;
  return (
    <View style={{ flex: 1, paddingTop: 80 }}>
      <Text>{offset() > 0 ? "list: scrolled" : "list: at top"}</Text>
      <Text>{`card: ${card() > 0 ? "dragged" : "still"}`}</Text>
      <Text>{`stock: ${opened() ? "opened" : "closed"}`}</Text>
      <Text>{`spark: ${scrubbed() ? "scrubbed" : "still"}`}</Text>
      <Text>{`Platform: ${platform.os}`}</Text>
      <View style={{ flex: 1 }}>
        <Scroll onScroll={(e) => offset.set(e.offset.y)} style={{ flex: 1 }}>
          <View
            testID="chart"
            panActivation={{ activeOffsetX: 6, failOffsetY: 8 }}
            onResponderMove={() => {}}
            style={{ height: 120, backgroundColor: "#e8eef6" }}
          />
          <View onPress={() => opened.set(true)} style={{ padding: 16, backgroundColor: "#f0e2d8" }}>
            <View
              testID="spark"
              panActivation={{ activeOffsetX: 6, failOffsetY: 8 }}
              onResponderMove={() => scrubbed.set(true)}
              style={{ height: 80, backgroundColor: "#d8e2f0" }}
            />
          </View>
          {Array.from({ length: 60 }, (_, i) => (
            <View style={{ height: 44, justifyContent: "center", paddingHorizontal: 16 }}>
              <Text>{`Message ${i + 1}`}</Text>
            </View>
          ))}
        </Scroll>
        <View
          testID="card"
          panActivation={{ activeOffsetY: 10, failOffsetX: 10 }}
          onResponderGrant={(e) => { startY = e.pageY; }}
          onResponderMove={(e) => card.set(Math.abs(e.pageY - startY))}
          style={{ position: "absolute", left: 16, right: 16, bottom: 16, height: 160, backgroundColor: "#dddddd" }}
        >
          <Text>Composer</Text>
        </View>
      </View>
    </View>
  );
}

mount(App);
