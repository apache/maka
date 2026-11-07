import { type JSX, mount, signal, Text, View } from "nsh";
import { Combobox, type OpenChangeReason, type SelectEntry, type SelectGroup } from "nsh/base";
import { CheckMark, desktop, Icon, Log, Panel, size, Split, ui } from "./palette";

// Two comboboxes in a card: labels for an issue, several picked in one go
// from a searchable list with sections, a clear button and a footer; and
// an assignee, one person replacing the last. The trigger is the
// field: the input typing filters the list with, and a chevron that
// turns while the list is open; the list is a popup at the trigger with a pointer, a sheet
// on a touch screen. Selected rows show a check in its own lane.

const LABELS = [
  { value: "bug", title: "Bug", group: "Type" },
  { value: "feature", title: "Feature", group: "Type" },
  { value: "docs", title: "Docs", group: "Type" },
  { value: "ios", title: "iOS", group: "Platform" },
  { value: "android", title: "Android", group: "Platform" },
  { value: "macos", title: "macOS", group: "Platform" },
  { value: "windows", title: "Windows", group: "Platform" },
  { value: "linux", title: "Linux", group: "Platform" },
  { value: "web", title: "Web", group: "Platform" },
  { value: "wontfix", title: "Won't fix", group: "Status", disabled: true },
  { value: "blocked", title: "Blocked", group: "Status" },
];

const PEOPLE = [
  { value: "ada", title: "Ada Lovelace" },
  { value: "grace", title: "Grace Hopper" },
  { value: "linus", title: "Linus Torvalds" },
  { value: "margaret", title: "Margaret Hamilton" },
];

const titlesOf = (items: { value: string; title: string }[], values: string[]) =>
  values.map((v) => items.find((i) => i.value === v)?.title ?? v);

/** The text of a control: 13 with a pointer, the touch label size otherwise. */
const controlText = desktop ? 13 : size.label;

/** A popup at the trigger with a pointer, a sheet at the bottom on a touch screen. */
const surface = () =>
  desktop
    ? { ...ui().card, borderRadius: 12, padding: 4 }
    : { ...ui().card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 30, maxHeight: "70%" as const };

const backdrop = { backgroundColor: "rgba(0,0,0,0.45)" };

/** The field: a bordered box around the input, the clear button and the chevron. */
const fieldStyle = (open: boolean) => ({
  flexDirection: "row" as const,
  alignItems: "center" as const,
  minHeight: size.control,
  paddingLeft: 10,
  paddingRight: 4,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: open ? ui().faint : ui().border,
  backgroundColor: ui().card.backgroundColor,
  ...(desktop ? { width: 260 } : {}),
});
const inputClass = () => `${desktop ? "text-sm" : "text-base"} placeholder:text-[${ui().faint}] text-[${ui().text}]`;
const inputStyle = { flex: 1, minWidth: 40, height: size.control - 2 };

/** The trigger button: a chevron that turns while the list is open. */
function Chevron(props: { open: boolean }) {
  return (
    <View
      class="transition-transform duration-150 motion-reduce:transition-none"
      style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", transform: [{ rotate: props.open ? "270deg" : "90deg" }] }}
    >
      <Text style={{ fontSize: 18, color: ui().muted }}>›</Text>
    </View>
  );
}

/**
 * A row's look, on the row itself (`itemClass`): the accent tint while
 * highlighted (the keys or the pointer, as the menus' rows), dimmed while
 * disabled. The states are the row's classes (`group`), so the list draws a
 * row's content once per item and the highlight moves without drawing.
 */
const rowClass =
  "group rounded-lg border border-transparent transition-colors duration-100 motion-reduce:transition-none " +
  "focus:border-brand/30 focus:bg-brand-tint active:opacity-70 disabled:opacity-40";

/** A row's content: the title, the check in its own lane (`group-selected:`). */
function Row(props: { item: SelectEntry }) {
  return (
    // The row's 1-point border on each side.
    <View style={{ height: size.rowSm - 2, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 7 }}>
      <Text style={{ numberOfLines: 1, flex: 1, fontSize: controlText, color: ui().text }}>{props.item.title}</Text>
      <View class="opacity-0 group-selected:opacity-100" style={{ width: 16 }}>
        <CheckMark size={16} tint={ui().accent} />
      </View>
    </View>
  );
}

function Header(props: { group: SelectGroup }) {
  return (
    <Text style={{ fontSize: 12, fontWeight: "500", color: ui().muted, paddingHorizontal: 9, paddingTop: 8, paddingBottom: 4 }}>
      {props.group.title}
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
  const labels = signal<string[]>(["bug", "ios"]);
  const assignee = signal<string[]>([]);
  const labelsOpen = signal(false);
  const assigneeOpen = signal(false);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 8));
  const opened = (open: (next: boolean) => void) => ({ open: next }: { open: boolean; reason: OpenChangeReason }) => open(next);
  const labelTitle = () => {
    const titles = titlesOf(LABELS, labels());
    return titles.length === 0 ? undefined : titles.length <= 2 ? titles.join(", ") : `${titles.length} labels`;
  };
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>combobox</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Pick several labels without the list closing; Cmd+Return confirms" : "Tap labels to toggle them; tap outside to finish"}
      </Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="value">
              <Text style={{ fontSize: 13, color: ui().text }}>{`labels [${labels().join(", ")}]`}</Text>
              <Text style={{ fontSize: 13, color: ui().text }}>{`assignee [${assignee().join(", ")}]`}</Text>
            </Panel>
            <Log title="onChange · onConfirm" lines={events()} minHeight={120} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, padding: 16, gap: 20 }}>
          <Field label="Labels" detail="Several at once, with search and sections">
            <Combobox
              items={LABELS}
              multiple
              value={labels()}
              onChange={({ value }) => {
                labels.set(value);
                log(`Labels → ${titlesOf(LABELS, value).join(", ") || "none"}`);
              }}
              onConfirm={({ value }) => log(`Confirmed ${value.length} labels`)}
              onOpenChange={opened((next) => labelsOpen.set(next))}
              accessibilityLabel="Labels"
              style={fieldStyle(labelsOpen())}
              placeholder={labelTitle() ?? "Add labels"}
              inputClass={inputClass()}
              inputStyle={inputStyle}
              triggerButton={<Chevron open={labelsOpen()} />}
              empty={<Text style={{ paddingVertical: 20, textAlign: "center", fontSize: 13, color: ui().muted }}>No label matches</Text>}
              offset={4}
              margin={8}
              popupStyle={surface()}
              backdropStyle={backdrop}
              itemClass={rowClass}
              cleanable
              clearButtonAccessibilityLabel="Clear the labels"
              clearButtonClass="items-center justify-center rounded-full enabled:hover:opacity-70"
              clearButtonStyle={{ width: 20, height: 20 }}
              clearButton={<Icon name="close" size={14} tint={ui().muted} />}
              footerStyle={{ borderTopWidth: 1, borderColor: ui().border, marginTop: 4, paddingTop: 4 }}
              footer={
                <View style={{ paddingHorizontal: 8, paddingVertical: 6 }}>
                  <Text style={{ fontSize: 12, color: ui().muted }}>{`${labels().length} selected`}</Text>
                </View>
              }
              renderItem={(item) => <Row item={item} />}
              renderGroup={(group) => <Header group={group} />}
            />
          </Field>
          <Field label="Assignee" detail="One person: a choice replaces the last">
            <Combobox
              items={PEOPLE}
              value={assignee()}
              onChange={({ value }) => {
                assignee.set(value);
                log(`Assignee → ${titlesOf(PEOPLE, value)[0] ?? "none"}`);
              }}
              onOpenChange={opened((next) => assigneeOpen.set(next))}
              accessibilityLabel="Assignee"
              offset={4}
              margin={8}
              popupStyle={surface()}
              backdropStyle={backdrop}
              itemClass={rowClass}
              style={fieldStyle(assigneeOpen())}
              placeholder="Assign someone"
              inputClass={inputClass()}
              inputStyle={inputStyle}
              triggerButton={<Chevron open={assigneeOpen()} />}
              renderItem={(item) => <Row item={item} />}
            />
          </Field>
        </View>
      </Split>
    </View>
  );
}

mount(App);
