// The displays the app sees, for `Resize.test.tsx` to place the window
// against, and a filling view (with a glass backdrop that activates Auto
// Layout in the window) whose layout must follow window resizes.
import { mount, signal, Text, View } from "nsh";
import { Window, displays } from "nsh/desktop";

mount(() => {
  const layout = signal({ width: 0, height: 0 });
  return (
    <Window id="main">
      <View
        class="flex-1"
        onLayout={({ bounds }) =>
          layout.set({ width: bounds.size.width, height: bounds.size.height })
        }
      >
        <Text>{JSON.stringify(displays())}</Text>
        <Text>{() => `Layout: ${Math.round(layout().width)}x${Math.round(layout().height)}`}</Text>
        <View style={{ height: 40, glassEffect: "regular", backdropFilter: "blur(20px)" }} />
      </View>
    </Window>
  );
});
