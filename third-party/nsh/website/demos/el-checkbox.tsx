import { mount, signal, Text, View } from "nsh";
import { Checkbox } from "nsh/base";
import { desktop, Log, Panel, Split, ui, CheckboxMark, checkboxLook, controlSize, listRow, RowDivider, RowLabel, sectionSurface } from "./palette";

// The parts take the shared looks: each row is the checkbox, its label
// included (`listRow`: the hover fill reaching past the content, the
// keyboard's focus ring, a press that dims, `disabled` dimmed), and the box
// (`checkboxLook`) sinks while its row (the `group`) is pressed. The mark
// shows the value the app owns: a check or, while some are checked, a dash,
// each fading in on a spring of its own, so a check turning into a dash
// crosses over. Nothing moves with reduced motion.
const items = [
  { id: "photos", label: "Photos", detail: "2,418 items · 6.1 GB" },
  { id: "documents", label: "Documents", detail: "312 files · 840 MB" },
  { id: "messages", label: "Messages", detail: "Attachments included · 1.2 GB" },
];

function App() {
  const selected = signal<string[]>(["photos"]);
  const events = signal<string[]>([]);
  const log = (e: string) => events.set([e, ...events()].slice(0, 3));
  const all = () => selected().length === items.length;
  const some = () => selected().length > 0 && !all();
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>checkbox</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click a row, or Tab to a checkbox and press Space" : "Tap a row: the label toggles it too"}
      </Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="checked · indeterminate">
              <Text style={{ fontSize: 13, color: ui().text }}>
                Back up everything: {all() ? "checked" : some() ? "indeterminate" : "unchecked"} · [{selected().join(", ")}]
              </Text>
            </Panel>
            <Log title="onChange({ checked })" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={sectionSurface({ padded: true })}>
          <Checkbox
            checked={all()}
            indeterminate={some()}
            onChange={({ checked }) => {
              selected.set(checked ? items.map((i) => i.id) : []);
              log(`Back up everything → ${checked}`);
            }}
            class="group"
            {...listRow({ first: true })}
            {...checkboxLook()}
            indicator={<CheckboxMark mark={all() ? "check" : some() ? "dash" : null} />}
          >
            <RowLabel label="Back up everything" detail={`${selected().length} of ${items.length} selected`} strong />
          </Checkbox>
          <Each of={items}>
            {(item) => (
              <Checkbox
                checked={selected().includes(item().id)}
                onChange={({ checked }) => {
                  selected.set(checked ? [...selected(), item().id] : selected().filter((id) => id !== item().id));
                  log(`${item().label} → ${checked}`);
                }}
                class="group"
                // One level under "Back up everything": the boxes line up with its label.
                {...listRow({ start: controlSize.control + controlSize.gap })}
                {...checkboxLook()}
                indicator={<CheckboxMark mark={selected().includes(item().id) ? "check" : null} />}
              >
                <RowDivider show />
                <RowLabel label={item().label} detail={item().detail} />
              </Checkbox>
            )}
          </Each>
        </View>

        <View style={sectionSurface({ padded: true })}>
          <Checkbox checked disabled class="group" {...listRow({ first: true, disabled: true })} {...checkboxLook()} indicator={<CheckboxMark mark="check" />}>
            <RowLabel label="System settings" detail="Always backed up" />
          </Checkbox>
        </View>
      </Split>
    </View>
  );
}

mount(App);
