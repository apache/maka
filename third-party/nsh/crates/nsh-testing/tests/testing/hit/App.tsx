import { mount, signal, Text, View } from "nsh";

// Buttons for `press`: one a press reaches, one under a view drawn over
// it, one of no size and one that hears no press.
function App() {
  const pressed = signal("none");
  const box = (left: number, top: number, width: number, height: number) => ({
    position: "absolute" as const,
    left,
    top,
    width,
    height,
  });
  return (
    <View style={{ flex: 1 }}>
      {/* The honest control: shown, bound, sized. */}
      <View style={box(10, 10, 120, 44)} onPress={() => pressed.set("resume")}>
        <Text>Resume</Text>
      </View>
      {/* Chip 1: bound and shown, but layout collapsed it to zero size. */}
      <View style={box(10, 80, 0, 0)} onPress={() => pressed.set("zero")}>
        <Text>Zero</Text>
      </View>
      {/* Chip 2: bound and sized, but the overlay below covers it. */}
      <View style={box(10, 150, 120, 44)} onPress={() => pressed.set("covered")}>
        <Text>Covered</Text>
      </View>
      <View style={box(0, 140, 200, 70)}>
        <Text>Overlay</Text>
      </View>
      {/* Chip 3: shown and sized, but its press binding never landed. */}
      <View style={box(10, 240, 120, 44)}>
        <Text>Unbound</Text>
      </View>
      <Text>{`Pressed: ${pressed()}`}</Text>
    </View>
  );
}

mount(App);
