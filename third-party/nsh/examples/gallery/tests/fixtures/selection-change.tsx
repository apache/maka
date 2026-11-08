import { mount, platform, signal, Text, View } from "nsh";
import { TextView, type TextViewRef } from "nsh/base";

// A selectable view and a selectable TextView that report what is selected
// (`onSelectionChange`): the text a copy would give, empty once nothing is.
function App() {
  const area = signal("");
  const doc = signal("");
  const md = signal("");
  const html = signal("");
  let view: TextViewRef | undefined;
  // What the ref reads of the selection, in each format.
  const read = async (text: string) => {
    doc.set(text);
    md.set((await view?.selectedText({ format: "markdown" })) ?? "");
    html.set((await view?.selectedText({ format: "html" })) ?? "");
  };
  return (
    <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: "white" }}>
      <Text style={{ color: "#111" }}>{`Platform: ${platform.os}`}</Text>
      <Text style={{ color: "#111" }}>{`Area [${area()}]`}</Text>
      <Text style={{ color: "#111" }}>{`Doc [${doc()}]`}</Text>
      <View selectable onSelectionChange={(e) => area.set(e.text)} style={{ gap: 8, width: 320 }}>
        <Text style={{ color: "#111", fontSize: 18 }}>Alpha beta gamma</Text>
        <Text style={{ color: "#111", fontSize: 18 }}>Delta epsilon</Text>
      </View>
      <View style={{ width: 320 }}>
        <TextView
          ref={(r) => (view = r)}
          selectable
          markdown={"Quote **this** part"}
          onSelectionChange={(e) => void read(e.text)}
        />
      </View>
      <Text style={{ color: "#111" }}>{`Markdown [${md()}]`}</Text>
      <Text style={{ color: "#111" }}>{`Html [${html()}]`}</Text>
    </View>
  );
}

mount(App);
