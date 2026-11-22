// A case of the API's test suite (docs/dev/compatibility.md): `Collapsible`
// of `nsh/base`, a region whose content expands and collapses, with no look
// of its own: its children always, its `content` after them while the
// app's `open` holds, out of the layout otherwise, and kept while
// collapsed (it follows the app and shows the latest when it opens). The
// trigger is the app's, and so is the expanded state screen readers hear on
// it. The region's height is how its script sees the content come and go.
import { Text, View, signal } from "nsh";
import { Collapsible } from "nsh/base";

function App() {
  const open = signal(false);
  const count = signal(0);
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <Collapsible
        testID="region"
        open={open()}
        class="gap-[4px]"
        content={
          <View testID="details" style={{ height: 30 }}>
            <Text>{`Details ${count()}`}</Text>
          </View>
        }
      >
        <View
          testID="trigger"
          role="button"
          accessibilityState={{ expanded: open() }}
          onPress={() => open.set(!open())}
          style={{ height: 20 }}
        >
          <Text>Summary</Text>
        </View>
      </Collapsible>
      <View testID="bump" onPress={() => count.set(count() + 1)} style={{ height: 20 }} />
    </View>
  );
}

export default App;
