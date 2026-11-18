// Initial mounting of real siblings with structural classes, without a
// Scroll viewport limiting Each's rows. Change COUNT, CLASSES and EACH to
// compare sizes, ordinary classes and the two creation paths.
import { View, mount } from "nsh";

const COUNT = 1000;
const CLASSES = "w-2 h-2 bg-red-500 odd:bg-blue-500";
const EACH = false;
const items = Array.from({ length: COUNT }, (_, i) => i);

mount(() => (
  <View class="flex-1 flex-row flex-wrap content-start">
    {EACH ? (
      <Each of={items}>{() => <View class={CLASSES} />}</Each>
    ) : (
      items.map(() => <View class={CLASSES} />)
    )}
  </View>
));
