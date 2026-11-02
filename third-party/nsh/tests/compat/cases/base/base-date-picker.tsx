// A case of the API's test suite (docs/dev/compatibility.md): `DatePicker`
// of `nsh/base` on a phone, where its calendar is a sheet: an ISO date the
// app owns (`value`, `onChange({ value })`, `null` once cleared), what
// screen readers hear as the value (`dateFormat`), the app's items
// (`renderItem`, `itemStyle`), weekends that take no press
// (`disabledMatcher`), the week's first day, Previous and Next; a range
// of the picker's own (`defaultValue`) over two months with a preset; and
// a date and time whose sheet a tap on a day closes and which opens
// again for the time (`timePrecision`, `hourCycle`, the time's label and
// segments). The
// dates are fixed, so nothing depends on today. Its script checks each.
import { Text, View, signal } from "nsh";
import { type CalendarItemState, DatePicker, type DatePickerValue } from "nsh/base";

/** Each item as a short text: a day's number (`*` selected, `~` in the range), the month and year toggles, the weekdays. */
function Item(props: { item: CalendarItemState }) {
  const i = props.item;
  const text =
    i.kind === "day"
      ? `D${i.value}${i.active ? "*" : ""}${i.inRange ? "~" : ""}`
      : i.kind === "monthToggle"
        ? `M${i.value}`
        : i.kind === "yearToggle"
          ? `Y${i.value}`
          : i.kind === "weekday"
            ? `W${i.value}`
            : i.kind;
  return <Text>{text}</Text>;
}

function App() {
  const due = signal<DatePickerValue>("2026-10-09");
  const opened = signal("Open: none");
  const trip = signal("Trip: none");
  const meet = signal("Meet: none");
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Text>{`Due: ${due()}`}</Text>
      <Text>{opened()}</Text>
      <Text>{trip()}</Text>
      <Text>{meet()}</Text>
      <DatePicker
        value={due()}
        onChange={({ value }) => due.set(value)}
        onOpenChange={({ open, reason }) => opened.set(`Open: ${open} ${reason}`)}
        accessibilityLabel="Due"
        dateFormat="%d.%m.%Y"
        disabledMatcher={[0, 6]}
        firstDayOfWeek={1}
        previousAccessibilityLabel="PrevMonth"
        nextAccessibilityLabel="NextMonth"
        itemStyle={{ width: 20, height: 20 }}
        renderItem={(item) => <Item item={item} />}
        cleanable
        clearButtonAccessibilityLabel="ClearDue"
        clearButtonStyle={{ width: 20, height: 20 }}
        clearButton={<Text>X</Text>}
        trigger={<View testID="due" style={{ height: 30 }}><Text>DueTrigger</Text></View>}
      />
      <DatePicker
        range
        defaultValue={["2026-10-05", "2026-10-07"]}
        onChange={({ value }) => trip.set(`Trip: ${JSON.stringify(value)}`)}
        accessibilityLabel="Trip"
        numberOfMonths={2}
        presets={[{ label: "Week", value: ["2026-10-19", "2026-10-25"] }]}
        presetsStyle={{ backgroundColor: "#0000ff" }}
        presetStyle={{ backgroundColor: "#00ff00" }}
        renderItem={(item) => <Item item={item} />}
        trigger={<View testID="trip" style={{ height: 30 }}><Text>TripTrigger</Text></View>}
      />
      <DatePicker
        defaultValue="2026-10-09T09:30"
        onChange={({ value }) => meet.set(`Meet: ${value}`)}
        accessibilityLabel="Meet"
        timePrecision="minute"
        hourCycle="h12"
        timeLabel={<Text>TimeLabel</Text>}
        timeAccessibilityLabel="MeetTime"
        segmentStyle={{ backgroundColor: "#ff0000" }}
        renderSegment={(segment) => <Text>{`S${segment.label}`}</Text>}
        renderItem={(item) => <Item item={item} />}
        trigger={<View testID="meet" style={{ height: 30 }}><Text>MeetTrigger</Text></View>}
      />
    </View>
  );
}

export default App;
