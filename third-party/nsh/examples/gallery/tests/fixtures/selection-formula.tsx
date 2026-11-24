import { mount, platform, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { TextView, type TextViewRef } from "nsh/base";

// Selectable TextViews with formulas (#2121), each reporting its selection
// as Markdown: a formula the selection covers stays in it.
function Case(props: { name: string; markdown: string }) {
  const md = signal("");
  let view: TextViewRef | undefined;
  const read = async () => md.set((await view?.selectedText({ format: "markdown" })) ?? "");
  return (
    <View style={{ gap: 4, width: 360 }}>
      <TextView ref={(r) => (view = r)} selectable markdown={props.markdown} onSelectionChange={() => void read()} />
      <Text style={{ color: "#111", fontSize: 12 }}>{`${props.name} [${md()}]`}</Text>
    </View>
  );
}

function App() {
  return (
    <View style={{ flex: 1, padding: 24, gap: 28, backgroundColor: "white" }}>
      <Text style={{ color: "#111" }}>{`Platform: ${platform.os}`}</Text>
      <Case name="inline" markdown={"First two\n\nAlpha $x^2$ omega\n\nLast two"} />
      <Case name="block" markdown={"First three\n\n$$\nx^2\n$$\n\nLast three"} />
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
