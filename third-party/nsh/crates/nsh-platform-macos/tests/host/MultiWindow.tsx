// Two windows of the app's own, for `MultiWindow.test.tsx`: what
// `windowSize()` reports with both open (#2912). Each window shows the
// sizes the app has seen, so a test can tell a size the app only saw for
// a moment, such as the hidden host's.
import { effect, mount, signal, Text, untracked, View, windowSize } from "nsh";
import { Window } from "nsh/desktop";

const seen = signal<string[]>([]);
effect(() => {
  const { width, height } = windowSize();
  const size = `${Math.round(width)}x${Math.round(height)}`;
  seen.set([...untracked(seen), size]);
});

function Sizes(props: { name: string }) {
  return (
    <View class="flex-1 p-4">
      <Text>{() => `${props.name} windowSize: ${seen().at(-1)}`}</Text>
      <Text>{() => `${props.name} seen: ${seen().join(",")}`}</Text>
    </View>
  );
}

mount(() => {
  const first = signal(true);
  return (
    <>
      <Window
        id="first"
        title="First"
        defaultSize={{ width: 480, height: 600 }}
        open={first()}
        onOpenChange={({ open }) => first.set(open)}
      >
        <Sizes name="first" />
      </Window>
      <Window id="second" title="Second" defaultSize={{ width: 360, height: 300 }}>
        <Sizes name="second" />
      </Window>
    </>
  );
});
