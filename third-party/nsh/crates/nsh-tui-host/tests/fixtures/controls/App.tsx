import { mount, View } from "nsh";
import { Controls } from "../../../../../examples/gallery/demos/Controls";

// The first card of each control the tests go through, in their order, above one "Last event" card.
mount(() => (
  <View style={{ flex: 1 }}>
    <Controls show="Switch" firsts={["Switch", "Checkbox", "Radio", "Tabs", "Collapsible", "Progress", "Slider"]} />
  </View>
));
