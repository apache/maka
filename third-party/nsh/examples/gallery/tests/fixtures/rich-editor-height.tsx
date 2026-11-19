import { mount, signal, Text, View } from "nsh";
import { createRichEditor, RichEditor, StarterKit } from "nsh/base";

// A chat composer: an editor without a height, as tall as what is typed, up to its max-height.
function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content: "First" });
  const height = signal(0);
  return (
    <View style={{ flex: 1, justifyContent: "flex-end", padding: 12 }}>
      <Text>{`Height ${Math.round(height())}`}</Text>
      <View onLayout={({ bounds }) => height.set(bounds.size.height)} style={{ borderWidth: 1, borderRadius: 12 }}>
        <RichEditor testID="composer" editor={editor} style={{ maxHeight: 120, paddingHorizontal: 8, paddingVertical: 10 }} />
      </View>
    </View>
  );
}

mount(App);
