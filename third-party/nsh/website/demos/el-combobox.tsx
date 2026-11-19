import { type JSX, mount, signal, Text, View } from "nsh";
import { Combobox, type OpenChangeReason } from "nsh/base";
import { desktop, Log, Panel, size, Split, ui, sectionSurface, clearButtonLook, ComboToggle, comboboxLook, ListboxEmpty, listboxFooter, ListboxHeader, listboxProps, OptionRow } from "./palette";

// Two comboboxes in a card: labels for an issue, several picked in one go
// from a searchable list with sections, a clear button and a footer; and
// an assignee, one person replacing the last. The look is the shared
// listbox look: the field (`comboboxLook`) is the well the input types in,
// its toggle (`ComboToggle`) a chevron that turns while the list is open;
// the list (`listboxProps`) a popup at the trigger with a pointer, a sheet
// on a touch screen; chosen rows show a check in its own lane.

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
        <View style={{ ...sectionSurface({ padded: true }), gap: 20 }}>
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
              {...comboboxLook(() => labelsOpen(), { filled: () => labels().length > 0 })}
              placeholder={labelTitle() ?? "Add labels"}
              triggerButton={<ComboToggle open={labelsOpen()} />}
              empty={<ListboxEmpty label="No label matches" />}
              {...listboxProps()}
              cleanable
              clearButtonAccessibilityLabel="Clear the labels"
              {...clearButtonLook()}
              footerStyle={listboxFooter.style}
              footer={<Text style={listboxFooter.text}>{`${labels().length} selected`}</Text>}
              renderItem={(item) => <OptionRow item={item} />}
              renderGroup={(group) => <ListboxHeader group={group} />}
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
              {...listboxProps()}
              {...comboboxLook(() => assigneeOpen())}
              placeholder="Assign someone"
              triggerButton={<ComboToggle open={assigneeOpen()} />}
              renderItem={(item) => <OptionRow item={item} />}
            />
          </Field>
        </View>
      </Split>
    </View>
  );
}

mount(App);
