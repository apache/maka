// A case of the API's test suite (docs/dev/compatibility.md): `Calendar`
// of `nsh/base` picking a range the app owns, as a range picker that
// commits on Apply does: the first press is reported by
// `onChangeStart({ value })` (`[start, null]`), which the app keeps as its
// value and shows outside the grid; the second by `onChange({ value })`,
// the complete range; the app's Cancel sets the range before back, which
// replaces the start. The dates are fixed, so nothing depends on today.
// Its script checks each.
import { Text, View, signal } from "nsh";
import { Calendar, type CalendarValue } from "nsh/base";

function App() {
  const applied: CalendarValue = ["2026-10-05", "2026-10-07"];
  const draft = signal<CalendarValue>(applied);
  const heard = signal("Heard: none");
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Text>{`Draft: ${JSON.stringify(draft())}`}</Text>
      <Text>{heard()}</Text>
      <View testID="cancel" style={{ height: 30 }} onPress={() => draft.set(applied)}>
        <Text>Cancel</Text>
      </View>
      <Calendar
        range
        value={draft()}
        onChangeStart={({ value }) => {
          draft.set(value);
          heard.set(`Heard: start ${JSON.stringify(value)}`);
        }}
        onChange={({ value }) => {
          draft.set(value);
          heard.set(`Heard: change ${JSON.stringify(value)}`);
        }}
      />
    </View>
  );
}

export default App;
