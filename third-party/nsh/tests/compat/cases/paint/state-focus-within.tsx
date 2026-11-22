// A case of the API's test suite (docs/dev/compatibility.md): the styles
// of a view while the keyboard focus is on a view inside it, which the
// core applies without JS: `focus-within:` classes and `focusWithinStyle`
// on a field's frame while the input in it has the focus, and on the view
// an `Overlay` is in while an input in the overlay has it (the overlay's
// content is inside that view, wherever the overlay shows). Its script
// reports the inputs' focus as a platform does and checks the styles
// mounted before, during and after it. The inputs read `focus:` themselves
// only because the script's `state` step needs a state the platform tracks.
import { Overlay, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="frame"
        class="h-12 bg-[#cccccc] opacity-50 focus-within:bg-[#3366ff]"
        focusWithinStyle={{ opacity: 1 }}
      >
        <View style={{ padding: 4 }}>
          <Input testID="field" class="h-8 focus:border-2" />
        </View>
      </View>
      <View testID="holder" class="h-12 bg-[#cccccc] focus-within:bg-[#00ff00]">
        <Overlay style={{ left: 0, top: 300, width: 200 }}>
          <Input testID="popup-field" class="h-8 focus:border-2" />
        </Overlay>
      </View>
    </View>
  );
}

export default App;
