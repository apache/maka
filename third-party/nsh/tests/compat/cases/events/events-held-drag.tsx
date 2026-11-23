// A long press lifts the row; moving it keeps the same touch until drop.
import { Text, View, signal } from "nsh";

export default function HeldDrag() {
  const phase = signal<"idle" | "down" | "lifted" | "moving" | "dropped">("idle");
  const ends = signal(0);
  const taps = signal(0);
  const longs = signal(0);
  return (
    <View class="flex-1 p-8 gap-4"
      onTouchMoveCapture={() => { if (phase() === "lifted") phase.set("moving"); }}
      onTouchEndCapture={() => {
        ends.set(ends() + 1);
        if (phase() === "moving" || phase() === "lifted") phase.set("dropped");
      }}>
      <View testID="source" class="w-48 h-24 bg-primary" delayLongPress={500}
        onTouchStart={() => phase.set("down")}
        onLongPress={() => { longs.set(longs() + 1); phase.set("lifted"); }}
        onPress={() => taps.set(taps() + 1)}>
        <Text>Drag source</Text>
      </View>
      <Text>{`phase=${phase()}`}</Text>
      <Text>{`ends=${ends()}`}</Text>
      <Text>{`longs=${longs()}`}</Text>
      <Text>{`taps=${taps()}`}</Text>
    </View>
  );
}
