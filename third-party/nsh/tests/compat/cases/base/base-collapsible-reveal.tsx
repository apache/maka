// A case of the API's test suite (docs/dev/compatibility.md): `Collapsible`
// of `nsh/base` with `reveal`, its content opening and closing with a
// clipped height that springs (a layout animation of the commit, run by the
// platform). The region that clips the content is in the layout while
// closed too, zero high, so the collapsible's gap comes before it; the
// content stays in the tree until the region has closed, then leaves it.
// The view after the collapsible moves with it.
import { Text, View, signal } from "nsh";
import { Collapsible } from "nsh/base";

function App() {
  const open = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <Collapsible
        testID="region"
        open={open()}
        reveal
        class="gap-[4px]"
        content={
          <View testID="details" style={{ height: 30 }}>
            <Text>Details</Text>
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
      <View testID="after" style={{ height: 20 }}>
        <Text>After</Text>
      </View>
    </View>
  );
}

export default App;
