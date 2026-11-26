import { List, mount, signal, Text, View } from "nsh";
import type { ListRef, ViewRef } from "nsh";

// Forty rows of 100 points under a bar of 60. "grow" doubles the rows above
// row 20: the core keeps the rows in sight in place with `ScrollBy`.
const ROWS = Array.from({ length: 40 }, (_, i) => i);

function App() {
  const grown = signal(false);
  const result = signal("");
  let list: ListRef | undefined;

  const Row = (item: () => number) => {
    let avatar: ViewRef | undefined;
    return (
      <View style={{ height: grown() && item() < 20 ? 200 : 100, justifyContent: "center", paddingLeft: 20 }}>
        <View
          ref={avatar}
          testID={`avatar-${item()}`}
          style={{ width: 40, height: 40 }}
          onMouseEnter={async ({ position, pagePosition }) => {
            const m = await avatar?.measure();
            result.set(`row ${item()}: ${pagePosition.y - position.y},${m?.pagePosition.y}`);
          }}
          onMouseLeave={() => result.set("")}
        />
      </View>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ height: 60, flexDirection: "row", alignItems: "center", gap: 16 }}>
        <View testID="jump" onPress={() => list?.scrollToIndex({ index: 20, animated: false })}>
          <Text>jump</Text>
        </View>
        <View testID="grow" onPress={() => grown.set(true)}>
          <Text>grow</Text>
        </View>
        <Text>{result()}</Text>
      </View>
      <List
        ref={list}
        style={{ flex: 1 }}
        each={ROWS}
        keyExtractor={(row) => String(row)}
        estimatedItemSize={100}
      >
        {Row}
      </List>
    </View>
  );
}

mount(App);
