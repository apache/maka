import { type JSX, mount, signal, Text, View, windowSize } from "nsh";
import { type CalendarEntry, DatePicker, type DatePickerValue, type DateRangePreset, type HourCycle, type OpenChangeReason, type TimeFieldSegmentEntry } from "nsh/base";
import { button, desktop, Icon, Log, Panel, Segmented, size, Split, ui, wide } from "./palette";

// Three date pickers in a card: a due date (weekends disabled, presets
// beside the calendar, a clear button), a stay picked as a range over two
// months in a wide window, and a meeting's date and time with the hours
// on the clock the inspector picks. The trigger is the shared button look
// with the value and a chevron that turns while the calendar is open; the
// calendar is a popup at the trigger, a sheet on a touch screen. Every
// item is drawn by `renderItem` (month names, weekday initials, today on a
// quiet fill, the selected days filled, a range's band) and every segment
// of the time by `renderSegment`; the time's label starts its row and the
// field, a well as the number inputs', ends it.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

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

/** The text of a control: 13 with a pointer, the touch label size otherwise. */
const controlText = desktop ? 13 : size.label;
/** A day's cell: seven across the popup with a pointer, across a phone's sheet otherwise. */
const cell = desktop ? 32 : 42;
/** The gap between the months of a calendar of two. */
const monthGap = 16;
/**
 * On a touch screen the calendar spans the sheet (the window less the sheet's padding), its columns sharing it: the
 * header's titles split what Previous and Next leave, so the month and the year meet in the middle, and each month's
 * title of two is over its month.
 */
const toggleWidth = () => Math.floor((windowSize().width - 2 * 10) / 2 - cell);

/** A popup at the trigger with a pointer, a sheet at the bottom on a touch screen. */
const surface = () =>
  desktop
    ? { ...ui().card, borderRadius: 12, padding: 8 }
    : { ...ui().card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 10, paddingTop: 14, paddingBottom: 30 };

const backdrop = { backgroundColor: "rgba(0,0,0,0.45)" };

/** The popup's layout: presets in a column beside the calendar with a pointer, a row of chips above it on a phone. */
const content = desktop ? { flexDirection: "row" as const, gap: 10 } : { gap: 12 };
const presets = () =>
  desktop
    ? { gap: 2, minWidth: 104, paddingRight: 10, borderRightWidth: 1, borderColor: ui().border }
    : { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };
const preset = () =>
  desktop
    ? { height: 28, paddingHorizontal: 8, borderRadius: 6, justifyContent: "center" as const, fontSize: 13, color: ui().text }
    : { height: 34, paddingHorizontal: 12, borderRadius: 17, borderWidth: 1, borderColor: ui().border, justifyContent: "center" as const, fontSize: 14, color: ui().text };
/** The calendar: in the popup with a pointer; across the sheet on a touch screen, as the time's row under it. */
const calendar = desktop ? { padding: 2 } : {};
/** The time's row under a hairline, its label at the start and the field at the end, on the calendar's edges. */
const time = () => ({
  gap: 10,
  marginTop: 8,
  paddingTop: 8,
  borderTopWidth: 1,
  borderColor: ui().border,
  ...(desktop ? { paddingHorizontal: 2 } : {}),
});
/** The time's field: a recessed well as the number inputs', with their hover and the keyboard's ring while it edits. */
const timeField = [
  desktop ? "h-8 rounded-lg px-2" : "h-11 rounded-xl px-3",
  "items-center border border-input bg-field",
  "enabled:hover:border-faint focus-within:outline-2 focus-within:outline-info",
].join(" ");

/** The trigger: the shared button's look, the value at the start and a chevron in a lane as wide as it. */
function Trigger(props: { title?: string; placeholder: string; open: boolean; clearable?: boolean }) {
  const look = button("secondary", {
    style: () => ({
      flexDirection: "row",
      justifyContent: "space-between",
      gap: 8,
      ...(desktop ? { width: 260 } : {}),
      ...(props.open ? { borderColor: ui().faint } : {}),
    }),
  });
  return (
    <View {...look}>
      <Text style={{ numberOfLines: 1, flex: 1, fontSize: controlText, color: props.title ? ui().text : ui().muted }}>
        {props.title ?? props.placeholder}
      </Text>
      {/* With a clear button over the end (`cleanable`), an empty lane as wide as the button in place of the chevron. */}
      <View
        class="transition-transform duration-150 motion-reduce:transition-none"
        style={{
          width: props.clearable ? 20 : 10,
          height: 20,
          alignItems: "center",
          justifyContent: "center",
          opacity: props.clearable ? 0 : 1,
          transform: [{ rotate: props.open ? "270deg" : "90deg" }],
        }}
      >
        <Text style={{ fontSize: 18, color: ui().muted }}>›</Text>
      </View>
    </View>
  );
}

/**
 * The calendar's items (`itemClass`): pressed at 70%; `group`, so the
 * drawing inside follows the item's states.
 */
const itemClass = "group active:opacity-70";

/**
 * An item of the calendar, drawn once from what it is, its states the
 * item's classes: Previous and Next as arrows (faint while they take no
 * press), the month and year toggles (or each month's title, with `months`
 * over one) by name, the open view's toggle in the accent, the weekdays'
 * initials, and the days: today on the theme's quiet `accent` fill
 * (gpui-component's), the selected date and a range's ends filled, the days
 * of a complete range on a band from end to end (`data-range-*`), the other
 * months' days and the disabled ones faint, the keyboard's day ringed.
 */
function Item(props: { item: CalendarEntry; months?: number }) {
  const kind = props.item.kind;
  if (kind === "previous" || kind === "next") {
    return (
      <View class="group-disabled:opacity-30" style={{ width: cell, height: cell, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 20, color: ui().muted }}>{kind === "previous" ? "‹" : "›"}</Text>
      </View>
    );
  }
  if (kind === "monthToggle" || kind === "yearToggle") {
    // A month's title in a calendar of several takes no press: the month and its year, over the month.
    const title = kind === "monthToggle" && (props.months ?? 1) > 1;
    return (
      <Text
        class="text-foreground group-selected:text-brand"
        style={{
          width: !desktop ? toggleWidth() : title ? 6 * cell + monthGap / 2 : kind === "monthToggle" ? 3 * cell : 2 * cell,
          paddingHorizontal: 3,
          textAlign: title ? "center" : kind === "monthToggle" ? "right" : "left",
          fontSize: size.label,
          fontWeight: "600",
        }}
      >
        {title ? `${MONTHS[props.item.value - 1]} ${props.item.year}` : kind === "monthToggle" ? MONTHS[props.item.value - 1] : String(props.item.value)}
      </Text>
    );
  }
  if (kind === "weekday") {
    return <Text style={{ minWidth: cell, paddingVertical: 4, textAlign: "center", fontSize: 11, color: ui().faint }}>{WEEKDAYS[props.item.value]}</Text>;
  }
  if (kind === "month" || kind === "year") {
    // The month view's months (rows of 3) and the year view's years (rows of 5), as wide as a month; the shown one
    // filled.
    return (
      <View
        class="rounded-lg group-selected:bg-brand-fill"
        style={{ minWidth: (7 * cell) / (kind === "month" ? 3 : 5), height: cell + 6, alignItems: "center", justifyContent: "center" }}
      >
        <Text class="text-foreground group-selected:text-on-brand" style={{ fontSize: controlText }}>
          {kind === "month" ? MONTHS[props.item.value - 1].slice(0, 3) : String(props.item.value)}
        </Text>
      </View>
    );
  }
  // A day, as wide as its column (the calendar's columns share its width). The band spans a range's middle days and
  // reaches from its ends' middles; a range of one day has none. The circle fills for the selected date and a
  // range's ends (not its middle days), else for today.
  const own = props.item.outside ? "text-faint" : "text-foreground";
  return (
    <View style={{ minWidth: cell, height: cell, alignItems: "center", justifyContent: "center" }}>
      <View
        class={
          "absolute inset-y-0.5 left-0 right-0 hidden bg-brand-tint group-data-range-middle:flex group-data-range-start:flex " +
          "group-data-range-start:left-1/2 group-data-range-end:flex group-data-range-end:right-1/2 group-data-range-start:group-data-range-end:hidden"
        }
      />
      <View
        class={
          `${props.item.today ? "bg-accent" : ""} border-[1.5px] border-transparent group-focus:border-info ` +
          "group-selected:bg-brand-fill group-data-range-middle:bg-transparent"
        }
        style={{ width: cell - 4, height: cell - 4, borderRadius: (cell - 4) / 2, alignItems: "center", justifyContent: "center" }}
      >
        <Text
          class={
            `${own} ${props.item.today ? "font-semibold" : "font-normal"} group-selected:font-semibold group-selected:text-on-brand ` +
            `group-data-range-middle:${own} group-disabled:text-faint group-disabled:opacity-50`
          }
          style={{ fontSize: controlText, fontVariant: ["tabular-nums"] }}
        >
          {String(props.item.value)}
        </Text>
      </View>
    </View>
  );
}

/**
 * A segment of the time: filled while it has the keys (`focus:` on the
 * segment, `segmentClass`), its digits or AM / PM in the color on the fill
 * (`group-focus:`), so moving between the segments draws nothing.
 */
const segmentClass = "group rounded active:opacity-70 focus:bg-brand-fill";
function Segment(props: { segment: TimeFieldSegmentEntry }) {
  return (
    <Text class="text-foreground group-focus:text-on-brand" style={{ paddingHorizontal: 3, fontSize: controlText, fontVariant: ["tabular-nums"] }}>
      {props.segment.label}
    </Text>
  );
}

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
        <View style={{ ...ui().card, borderRadius: 16, padding: 16, gap: 20 }}>
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
              offset={4}
              margin={8}
              popupStyle={surface()}
              backdropStyle={backdrop}
              contentStyle={content}
              presetsStyle={presets()}
              presetStyle={preset()}
              presetClass="active:opacity-70"
              calendarStyle={calendar}
              headerStyle={{ marginBottom: 4 }}
              itemClass={itemClass}
              renderItem={(item) => <Item item={item} />}
              style={desktop ? { width: 260 } : undefined}
              cleanable
              clearButtonAccessibilityLabel="Clear the due date"
              clearButtonClass="absolute items-center justify-center rounded-full enabled:hover:opacity-70"
              clearButtonStyle={{ top: (size.control - 20) / 2, right: 10, width: 20, height: 20 }}
              clearButton={<Icon name="close" size={14} tint={ui().muted} />}
              trigger={<Trigger title={due() ? `${monthDay(due()!)}, ${due()!.slice(0, 4)}` : undefined} placeholder="No due date" open={dueOpen()} clearable={due() !== null} />}
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
              offset={4}
              margin={8}
              popupStyle={surface()}
              backdropStyle={backdrop}
              contentStyle={content}
              presetsStyle={presets()}
              presetStyle={preset()}
              presetClass="active:opacity-70"
              calendarStyle={calendar}
              headerStyle={{ marginBottom: 4 }}
              bodyStyle={{ gap: monthGap }}
              itemClass={itemClass}
              renderItem={(item) => <Item item={item} months={wide() ? 2 : 1} />}
              trigger={<Trigger title={stayTitle()} placeholder="Check-in – check-out" open={stayOpen()} />}
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
              offset={4}
              margin={8}
              popupStyle={surface()}
              backdropStyle={backdrop}
              calendarStyle={calendar}
              headerStyle={{ marginBottom: 4 }}
              itemClass={itemClass}
              renderItem={(item) => <Item item={item} />}
              timeStyle={time()}
              timeLabel={<Text style={{ fontSize: controlText, color: ui().muted }}>Time</Text>}
              timeAccessibilityLabel="Meeting time"
              timeFieldClass={timeField}
              segmentClass={segmentClass}
              separatorStyle={{ fontSize: controlText, color: ui().faint }}
              renderSegment={(segment) => <Segment segment={segment} />}
              trigger={<Trigger title={meetingTitle()} placeholder="Not scheduled" open={meetingOpen()} />}
            />
          </Field>
        </View>
      </Split>
    </View>
  );
}

mount(App);
