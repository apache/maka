import { List, mount, platform, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";

// Rows of 100 pt in a 300 pt list that estimates them at 20 pt: below the
// rows rendered so far the list's content is shorter than it will be. The
// list follows its end as rows are added while it is at the end.
function App() {
  const rows = signal(Array.from({ length: 40 }, (_, i) => i));
  const y = signal(0);
  const add = () => {
    const n = rows().length;
    rows.set([...rows(), ...Array.from({ length: 30 }, (_, i) => n + i)]);
  };
  return (
    <View style={{ flex: 1, padding: 24, gap: 8, backgroundColor: "white" }}>
      <Text style={{ color: "#111" }}>{`OS: ${platform.os}`}</Text>
      <Text style={{ color: "#111" }}>{`y=${Math.round(y())} rows=${rows().length}`}</Text>
      <View role="button" onPress={add} style={{ height: 32, justifyContent: "center" }}>
        <Text style={{ color: "#111" }}>Add 30 rows</Text>
      </View>
      {/* A plain view, which every host makes natively: the pointer the keys follow rests on it. */}
      <View testID="list">
        <List
          each={rows()}
          estimatedItemSize={20}
          maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 40 }}
          onScroll={(e) => y.set(e.offset.y)}
          style={{ height: 300, backgroundColor: "#f4f4f5" }}
        >
          {(row) => (
            <View style={{ height: 100, justifyContent: "center", paddingHorizontal: 12 }}>
              <Text style={{ color: "#111" }}>{`Row ${row()}`}</Text>
            </View>
          )}
        </List>
      </View>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
