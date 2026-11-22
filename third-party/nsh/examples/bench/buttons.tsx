// The two benchmark screens, parameterized by the Button under test, so a
// Rust component and a TSX composition (`TsButton.tsx`) run the same app.
import { type Component, List, Scroll, signal, Text, View } from "nsh";

/** The props both Buttons take. */
export interface BenchButtonProps {
  title: string;
  variant?: "primary" | "secondary" | "plain";
  onPress?: () => void;
}

const rows = Array.from({ length: 200 }, (_, i) => i);

/** 200 Buttons in a scroll view. The first press target bumps a counter
 * that every title shows: one tap updates all 200 titles. */
export function Grid(props: { Button: Component<BenchButtonProps> }) {
  const count = signal(0);
  const Button = props.Button;
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ padding: 16, gap: 8 }}>
        <View onPress={() => count.update((c) => c + 1)} style={{ padding: 12 }}>
          <Text>Bump</Text>
        </View>
        <Each of={rows}>
          {(i) => <Button title={`Row ${i()} · ${count()}`} variant={i() % 3 === 0 ? "primary" : i() % 3 === 1 ? "secondary" : "plain"} />}
        </Each>
      </View>
    </Scroll>
  );
}

const items = Array.from({ length: 1000 }, (_, i) => i);

/** A recycled list of 1000 rows with a Button each: scrolling rebinds rows. */
export function Rows(props: { Button: Component<BenchButtonProps> }) {
  const Button = props.Button;
  return (
    <List each={items} estimatedItemSize={64} style={{ flex: 1 }}>
      {(i) => (
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8, gap: 12 }}>
          <Text style={{ flex: 1 }}>{`Item ${i()}`}</Text>
          <Button title={`Open ${i()}`} variant={i() % 2 === 0 ? "primary" : "secondary"} />
        </View>
      )}
    </List>
  );
}
