import { mount, signal, Scroll, Text, View } from "nsh";

// A scroll view whose content overflows its viewport (784 points of
// content in 744), over a bar the app draws below it. The button
// `probe-toggle` sits across the fold: of its laid-out frame 724..784,
// the top 20 points are visible, and its center — where a press lands —
// is 10 points below the fold, on the bar. Nothing is drawn over the
// visible half. Expected: the press reaches the button, as a finger on
// its visible half would. `probe-visible`, wholely above the fold, is
// the control: a press inside the same scroll view works when nothing
// clips the button.
function App() {
  const pressed = signal("none");
  return (
    <View style={{ flex: 1 }}>
      <Scroll style={{ flex: 1 }}>
        <View style={{ paddingTop: 664, rowGap: 20, paddingHorizontal: 16 }}>
          <View
            testID="probe-visible"
            onPress={() => pressed.set("visible")}
            style={{ width: 120, height: 40, alignItems: "center", justifyContent: "center" }}
          >
            <Text>Visible toggle</Text>
          </View>
          <View
            testID="probe-toggle"
            onPress={() => pressed.set("toggle")}
            style={{ width: 120, height: 60, alignItems: "center", justifyContent: "center" }}
          >
            <Text>Probe toggle</Text>
          </View>
        </View>
      </Scroll>

      <View testID="below" style={{ height: 100, padding: 16 }}>
        <Text>{`Pressed: ${pressed()}`}</Text>
      </View>
    </View>
  );
}

mount(App);
