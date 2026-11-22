// A case of the API's test suite (docs/dev/compatibility.md): a popover's
// trigger styled while its popup is open, which the core applies without
// JS: `aria-expanded:` classes and `expandedStyle` while
// `accessibilityState.expanded` is `true` (the state `Popover` sets on
// its trigger), and `group-aria-expanded:` on the chevron inside it. Its
// script opens and closes the popover and checks the styles mounted in
// each state.
import { Text, View } from "nsh";
import { Popover } from "nsh/base";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Popover
        trigger={
          <View
            testID="trigger"
            class="group h-8 w-24 bg-[#cccccc] aria-expanded:bg-[#3355ff]"
            expandedStyle={{ borderWidth: 2, borderColor: "#000000" }}
          >
            <View testID="chevron" class="size-4 bg-[#ffffff] group-aria-expanded:bg-[#222222]" />
          </View>
        }
      >
        <Text>Popup</Text>
      </Popover>
    </View>
  );
}

export default App;
