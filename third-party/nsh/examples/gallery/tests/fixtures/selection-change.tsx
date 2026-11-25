import { mount, platform, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { TextView, type TextViewRef } from "nsh/base";

// A selectable view and a selectable TextView that report what is selected
// (`onSelectionChange`): the text a copy would give, empty once nothing is,
// and where it is where the platform knows it.
function App() {
  const area = signal("");
  // The box around the area's selection: in the area, then its corner in
  // the root view.
  const box = signal("");
  const doc = signal("");
  const docBox = signal("");
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
      <Text style={{ color: "#111" }}>{`Box [${box()}]`}</Text>
      <Text style={{ color: "#111" }}>{`Doc box [${docBox()}]`}</Text>
      <View
        selectable
        onSelectionChange={(e) => {
          area.set(e.text);
          const b = e.bounds;
          const p = e.pageBounds;
          box.set(
            b && p ? [b.origin.x, b.origin.y, b.size.width, b.size.height, p.origin.x, p.origin.y].map(Math.round).join(" ") : "",
          );
        }}
        style={{ gap: 8, width: 320 }}
      >
        <Text style={{ color: "#111", fontSize: 18 }}>Alpha beta gamma</Text>
        <Text style={{ color: "#111", fontSize: 18 }}>Delta epsilon</Text>
      </View>
      <View style={{ width: 320 }}>
        <TextView
          ref={(r) => (view = r)}
          selectable
          markdown={"Quote **this** part"}
          onSelectionChange={(e) => {
            void read(e.text);
            docBox.set(e.pageBounds ? "placed" : "");
          }}
        />
      </View>
      <Text style={{ color: "#111" }}>{`Markdown [${md()}]`}</Text>
      <Text style={{ color: "#111" }}>{`Html [${html()}]`}</Text>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
