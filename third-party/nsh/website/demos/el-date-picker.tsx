import { type JSX, mount, signal, Text, View } from "nsh";
import { DatePicker, type DatePickerValue, type DateRangePreset, type HourCycle, type OpenChangeReason } from "nsh/base";
import { desktop, Log, Panel, Segmented, size, Split, ui, wide, sectionSurface, controlSize, clearButtonLook, datePickerLook, Picker } from "./palette";

// Three date pickers in a card: a due date (weekends disabled, presets
// beside the calendar, a clear button), a stay picked as a range over two
// months in a wide window, and a meeting's date and time with the hours
// on the clock the inspector picks. The look is the shared listbox look:
// the trigger (`Picker`) with the value and a chevron that turns while the
// calendar is open, and `datePickerLook` for the rest: the popup at the
// trigger (a sheet on a touch screen), the items (`CalendarItem`: month
// names, weekday initials, today on a quiet fill, the selected days filled,
// a range's band), the presets, and the time's row, segments and well.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A day's ISO date (`"2026-10-28"`), in local time as the calendar's days are. */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
/** An ISO date's month and day: `Oct 28`. */
const monthDay = (value: string) => `${MONTHS[Number(value.slice(5, 7)) - 1].slice(0, 3)} ${Number(value.slice(8, 10))}`;

/** A time `"HH:MM"` on the picked clock: `14:30`, or `2:30 PM`. */
function clock(time: string, cycle: HourCycle) {
  if (cycle === "h23") return time;
  const hour = Number(time.slice(0, 2));
  return `${hour % 12 === 0 ? 12 : hour % 12}:${time.slice(3, 5)} ${hour < 12 ? "AM" : "PM"}`;
}

/** A trigger's width: set with a pointer, the field's on a touch screen. */
const trigger = desktop ? { width: 260 } : undefined;

/** A label over its control, a quieter line under the label. */
function Field(props: { label: string; detail: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: size.label, fontWeight: "500", color: ui().text }}>{props.label}</Text>
        <Text style={{ fontSize: size.detail, color: ui().muted }}>{props.detail}</Text>
      </View>
      {props.children}
    </View>
  );
}

function App() {
  const due = signal<string | null>(null);
  const stay = signal<DatePickerValue>(null);
  const meeting = signal<string | null>(null);
  const cycle = signal<HourCycle>("h12");
  const dueOpen = signal(false);
  const stayOpen = signal(false);
  const meetingOpen = signal(false);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 8));
  const opened = (open: (next: boolean) => void) => ({ open: next }: { open: boolean; reason: OpenChangeReason }) => open(next);
  // The presets from today.
  const today = new Date();
  const monday = addDays(today, ((8 - today.getDay()) % 7) || 7);
  const dues: DateRangePreset[] = [
    { label: "Today", value: iso(today) },
    { label: "Tomorrow", value: iso(addDays(today, 1)) },
    { label: "Next Monday", value: iso(monday) },
  ];
  const stays: DateRangePreset[] = [
    { label: "This week", value: [iso(today), iso(addDays(today, (7 - today.getDay()) % 7))] },
    { label: "Next 7 nights", value: [iso(today), iso(addDays(today, 7))] },
  ];
  const stayTitle = () => {
    const r = stay();
    return Array.isArray(r) && r[0] && r[1] ? `${monthDay(r[0])} – ${monthDay(r[1])}, ${r[1].slice(0, 4)}` : undefined;
  };
  const meetingTitle = () => {
    const v = meeting();
    return v ? `${monthDay(v)}, ${v.slice(0, 4)} · ${clock(v.slice(11, 16), cycle())}` : undefined;
  };
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>date-picker</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Arrows move between days, Return picks; the trigger takes Delete to clear" : "Tap a day; the meeting's time takes digits"}
      </Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="value">
              <Text style={{ fontSize: 13, color: ui().text }}>{`due ${JSON.stringify(due())}`}</Text>
              <Text style={{ fontSize: 13, color: ui().text }}>{`stay ${JSON.stringify(stay())}`}</Text>
              <Text style={{ fontSize: 13, color: ui().text }}>{`meeting ${JSON.stringify(meeting())}`}</Text>
            </Panel>
            <Segmented label="hourCycle" options={["h12", "h23"] as const} value={cycle()} onChange={(v) => cycle.set(v)} />
            <Log title="onChange" lines={events()} minHeight={120} />
          </>
        }
      >
        <View style={{ ...sectionSurface({ padded: true }), gap: 20 }}>
          <Field label="Due" detail="Weekdays only, presets beside the calendar, a clear button">
            <DatePicker
              value={due()}
              onChange={({ value }) => {
                due.set(typeof value === "string" ? value : null);
                log(`Due → ${JSON.stringify(value)}`);
              }}
              onOpenChange={opened((next) => dueOpen.set(next))}
              accessibilityLabel="Due"
              disabledMatcher={[0, 6]}
              presets={dues}
              {...datePickerLook()}
              style={trigger}
              cleanable
              clearButtonAccessibilityLabel="Clear the due date"
              {...clearButtonLook({ over: true })}
              trigger={<Picker title={due() ? `${monthDay(due()!)}, ${due()!.slice(0, 4)}` : "No due date"} placeholder={!due()} open={dueOpen()} clearable={due() !== null} style={trigger} />}
            />
          </Field>
          <Field label="Stay" detail={wide() ? "A range over two months: the first press starts it" : "A range: the first press starts it, the second ends it"}>
            <DatePicker
              range
              value={stay()}
              onChange={({ value }) => {
                stay.set(value);
                log(`Stay → ${JSON.stringify(value)}`);
              }}
              onOpenChange={opened((next) => stayOpen.set(next))}
              accessibilityLabel="Stay"
              numberOfMonths={wide() ? 2 : 1}
              firstDayOfWeek={1}
              presets={stays}
              {...datePickerLook({ months: () => (wide() ? 2 : 1) })}
              trigger={<Picker title={stayTitle() ?? "Check-in – check-out"} placeholder={!stayTitle()} open={stayOpen()} style={trigger} />}
            />
          </Field>
          <Field label="Meeting" detail={desktop ? "A day, then its time; the day again closes the calendar" : "A tap picks the day; open it again for the time"}>
            <DatePicker
              value={meeting()}
              onChange={({ value }) => {
                meeting.set(typeof value === "string" ? value : null);
                log(`Meeting → ${JSON.stringify(value)}`);
              }}
              onOpenChange={opened((next) => meetingOpen.set(next))}
              accessibilityLabel="Meeting"
              timePrecision="minute"
              hourCycle={cycle()}
              defaultTime="09:00"
              {...datePickerLook()}
              timeLabel={<Text style={{ fontSize: controlSize.label, color: ui().muted }}>Time</Text>}
              timeAccessibilityLabel="Meeting time"
              trigger={<Picker title={meetingTitle() ?? "Not scheduled"} placeholder={!meetingTitle()} open={meetingOpen()} style={trigger} />}
            />
          </Field>
        </View>
      </Split>
    </View>
  );
}

mount(App);
