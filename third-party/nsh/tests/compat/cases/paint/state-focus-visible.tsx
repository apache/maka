// A case of the API's test suite (docs/dev/compatibility.md): the styles
// of a view while its keyboard focus shows, which the core applies without
// JS: `focus-visible:` classes and `focusVisibleStyle`. A field that
// edits shows its focus however it got it (as a browser's
// `:focus-visible`), so the script's `state` step, which reports the focus
// as a platform does, shows it whatever input came before. It reads
// `focus:` too only because that step needs a state the platform tracks.
import { View } from "nsh";
import { Input } from "nsh/base";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Input
        testID="ringed"
        class="h-8 bg-[#cccccc] opacity-50 focus:border-2 focus-visible:bg-[#3366ff]"
        focusVisibleStyle={{ opacity: 1 }}
      />
    </View>
  );
}

export default App;
