// Hover tracks follow changes in the target's overflow on both axes.
import { Scroll, Text, View, signal, type ViewRef } from "nsh";
import { Scrollbar } from "nsh/base";

export default function App() {
  const grows = signal(false);
  let vertical: ViewRef | undefined;
  let horizontal: ViewRef | undefined;
  return (
    <View style={{ paddingTop: 20, gap: 8 }}>
      <View testID="resize-content" onPress={() => grows.set(!grows())} style={{ height: 30 }}>
        <Text>{grows() ? "Shrink" : "Grow"}</Text>
      </View>
      <View style={{ width: 200, height: 100 }}>
        <Scroll ref={vertical} scrollbar={false} style={{ flex: 1 }}>
          <View style={{ height: grows() ? 500 : 50 }} />
        </Scroll>
        <Scrollbar
          scroll={vertical}
          mode="hover"
          accessibilityLabel="Vertical hover bar"
          class="absolute inset-y-0 right-0 w-[10px]"
          thumbClass="w-full"
        />
      </View>
      <View style={{ width: 200, height: 100 }}>
        <Scroll ref={horizontal} horizontal scrollbar={false} style={{ flex: 1 }}>
          <View style={{ width: grows() ? 500 : 50, height: 100 }} />
        </Scroll>
        <Scrollbar
          scroll={horizontal}
          axis="horizontal"
          mode="hover"
          accessibilityLabel="Horizontal hover bar"
          class="absolute inset-x-0 bottom-0 h-[10px]"
          thumbClass="h-full"
        />
      </View>
    </View>
  );
}
