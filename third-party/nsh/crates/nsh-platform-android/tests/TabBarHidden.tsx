import { mount, signal, Text, View } from "nsh";
import { TabBar } from "nsh/mobile";

function App() {
  const hidden = signal(true);
  const selected = signal(0);
  const bottomHits = signal(0);
  return (
    <View style={{ flex: 1, paddingTop: 60 }}>
      <Text>{`hidden=${hidden()} selected=${selected()} hits=${bottomHits()}`}</Text>
      <View
        testID="toggle"
        role="button"
        onPress={() => hidden.set(!hidden())}
        style={{ padding: 16 }}
      >
        <Text>Toggle</Text>
      </View>
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 24,
          height: 72,
          flexDirection: "row",
        }}
      >
        <View style={{ flex: 1 }} />
        <View
          testID="bottom-right"
          role="button"
          onPress={() => bottomHits.set(bottomHits() + 1)}
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text>BottomRight</Text>
        </View>
      </View>
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          pointerEvents: "box-none",
        }}
      >
        <TabBar
          items={[{ title: "Records" }, { title: "Stats" }]}
          selectedIndex={selected()}
          hidden={hidden()}
          onChange={({ index }) => selected.set(index)}
        />
      </View>
    </View>
  );
}

mount(() => <App />);
