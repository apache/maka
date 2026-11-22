// A pager whose pages arrive after a scroll command: the command waits for them.
import type { ScrollRef } from "nsh";
import { mount, Scroll, signal, Text, View } from "nsh";

const W = 300;

const Button = (props: { id: string; onPress: () => void }) => (
  <View testID={props.id} onPress={props.onPress} style={{ padding: 8, backgroundColor: "#ddd" }}>
    <Text>{props.id}</Text>
  </View>
);

function App() {
  const shown = signal(false);
  const pages = signal<number[]>([0, 1]);
  const end = signal(-1);
  let ref: ScrollRef | undefined;
  return (
    <View style={{ padding: 40, gap: 8 }}>
      <Text>{`end=${end()}`}</Text>
      <Button id="show-late" onPress={() => {
        pages.set([]);
        shown.set(true);
        setTimeout(() => pages.set([0, 1]), 50);
      }} />
      <Button id="show" onPress={() => shown.set(true)} />
      <Button id="empty" onPress={() => pages.set([])} />
      <Button id="fill" onPress={() => pages.set([0, 1])} />
      <Button id="second" onPress={() => ref?.scrollTo({ x: W, animated: false })} />
      {shown() ? (
        <Scroll
          ref={(r) => (ref = r)}
          horizontal
          pagingEnabled
          style={{ width: W, height: 120 }}
          contentOffset={{ x: W, y: 0 }}
          onScrollEnd={(e) => end.set(Math.round(e.offset.x))}
        >
          <View style={{ flexDirection: "row" }}>
            {pages().map((p) => (
              <View style={{ width: W, height: 120, backgroundColor: p ? "#4a8" : "#a48" }}>
                <Text>{`page ${p}`}</Text>
              </View>
            ))}
          </View>
        </Scroll>
      ) : (
        <Text>hidden</Text>
      )}
    </View>
  );
}

mount(() => <App />);
