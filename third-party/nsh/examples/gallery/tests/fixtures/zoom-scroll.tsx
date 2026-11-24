import { mount, platform, Scroll, type ScrollRef, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";

// A scroll view that zooms from 0.5 to 4 over a grid of tiles; the scale
// and offset it reports, and a button zooming it around a tile.
function App() {
  let scroll: ScrollRef | undefined;
  const scale = signal(1);
  const y = signal(0);
  const pressed = signal("none");
  const tiles = Array.from({ length: 16 }, (_, i) => i);
  return (
    <View style={{ flex: 1, padding: 24, gap: 8, backgroundColor: "white" }}>
      <Text style={{ color: "#111" }}>{`OS: ${platform.os}`}</Text>
      <Text style={{ color: "#111" }}>{`zoom=${scale().toFixed(2)} y=${Math.round(y())}`}</Text>
      <Text style={{ color: "#111" }}>{`pressed=${pressed()}`}</Text>
      <View role="button" onPress={() => scroll?.zoomTo({ scale: 2, x: 0, y: 0, animated: false })} style={{ height: 32, justifyContent: "center" }}>
        <Text style={{ color: "#111" }}>Zoom to the first tile</Text>
      </View>
      <View role="button" onPress={() => scroll?.zoomTo({ scale: 1, animated: false })} style={{ height: 32, justifyContent: "center" }}>
        <Text style={{ color: "#111" }}>Fit</Text>
      </View>
      <Scroll
        ref={scroll}
        testID="zoom"
        minimumZoomScale={0.5}
        maximumZoomScale={4}
        onScroll={(e) => {
          scale.set(e.zoomScale);
          y.set(e.offset.y);
        }}
        style={{ width: 320, height: 320, backgroundColor: "#f4f4f5" }}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", width: 320 }}>
          {tiles.map((i) => (
            <View
              role="button"
              accessibilityLabel={`Tile ${i}`}
              onPress={() => pressed.set(`${i}`)}
              style={{ width: 80, height: 80, backgroundColor: i % 2 ? "#c7d2fe" : "#a5b4fc" }}
            />
          ))}
        </View>
      </Scroll>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
