// A case of the API's test suite (docs/dev/compatibility.md): `TimeField`
// of `nsh/base` with `min` and `max`, the same `"HH:MM"` form as `value`.
// A typed time before `min` is held to it, one after `max` to that, and a
// `min` after `max` leaves both out.
import { Text, View, signal } from "nsh";
import { TimeField } from "nsh/base";

function App() {
  const appointment = signal("09:30");
  const office = signal("09:30");
  const inverted = signal("12:00");
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Text>{`Appointment ${appointment()}`}</Text>
      <TimeField
        value={appointment()}
        onChange={({ value }) => appointment.set(value)}
        min="09:00"
        max="17:30"
        accessibilityLabel="Appointment"
        class="flex-row h-[30px]"
        segmentClass="px-0.5"
        separatorClass="px-0.5"
      />
      <Text>{`Office ${office()}`}</Text>
      <TimeField
        value={office()}
        onChange={({ value }) => office.set(value)}
        min="09:00"
        max="17:30"
        accessibilityLabel="Office"
        class="flex-row h-[30px]"
        segmentClass="px-0.5"
        separatorClass="px-0.5"
      />
      <Text>{`Inverted ${inverted()}`}</Text>
      <TimeField
        value={inverted()}
        onChange={({ value }) => inverted.set(value)}
        min="18:00"
        max="09:00"
        accessibilityLabel="Inverted"
        class="flex-row h-[30px]"
        segmentClass="px-0.5"
        separatorClass="px-0.5"
      />
    </View>
  );
}

export default App;
