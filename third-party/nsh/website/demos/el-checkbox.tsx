import { mount, signal, Text, View } from "nsh";
import { Checkbox } from "nsh/base";
import { CheckMark, desktop, focusRing, hoverFill, Log, Panel, size, Split, ui } from "./palette";

// The parts: geometry and motion in classes (`disabled:` dims the row,
// following the checkbox; `group-checked:` / `group-indeterminate:` fade in
// the mark of the indicator's state, both kept mounted so each fades out
// too, and a check turning into a dash crosses over), colors from the
// palette by the value the app owns; the pointer's hover and the keyboard's
// focus ring from the palette too. Nothing moves with reduced motion.
const row = `flex-row items-center gap-3 ${desktop ? "px-3 py-2" : "px-4 py-3"} active:opacity-70 disabled:opacity-40`;
const indicator = "group size-5 items-center justify-center rounded-md border transition-colors motion-reduce:transition-none";

/** The indicator's surface: the accent while checked or indeterminate. */
const box = (on: boolean) => (on ? ui().accentFill : { ...ui().inset, borderColor: ui().faint });

/** A mark over the box, centered: hidden and a little smaller until its state's `group-*:` classes show it. */
const layer = "absolute inset-0 items-center justify-center opacity-0 scale-75 transition duration-150 ease-out motion-reduce:transition-none";

/** A check while checked, a dash while indeterminate. */
const mark = () => (
  <>
    <View class={`${layer} group-checked:opacity-100 group-checked:scale-100`}>
      <CheckMark size={14} weight={2.5} tint={ui().onAccent} />
    </View>
    <View class={`${layer} group-indeterminate:opacity-100 group-indeterminate:scale-100`}>
      <View class="h-0.5 w-2.5 rounded-full" style={{ backgroundColor: ui().onAccent }} />
    </View>
  </>
);

const items = [
  { id: "photos", label: "Photos", detail: "2,418 items · 6.1 GB" },
  { id: "documents", label: "Documents", detail: "312 files · 840 MB" },
  { id: "messages", label: "Messages", detail: "Attachments included · 1.2 GB" },
];

function Label(props: { label: string; detail: string; strong?: boolean }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ fontSize: size.label, fontWeight: props.strong ? "600" : "500", color: ui().text }}>{props.label}</Text>
      <Text style={{ fontSize: size.detail, color: ui().muted }}>{props.detail}</Text>
    </View>
  );
}

function App() {
  const selected = signal<string[]>(["photos"]);
  const events = signal<string[]>([]);
  const log = (e: string) => events.set([e, ...events()].slice(0, 3));
  const all = () => selected().length === items.length;
  const some = () => selected().length > 0 && !all();
  const line = () => <View style={{ height: 1, marginLeft: desktop ? 44 : 48, backgroundColor: ui().line }} />;
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
        <View style={{ ...ui().card, borderRadius: 16, overflow: "hidden" }}>
          <Checkbox
            checked={all()}
            indeterminate={some()}
            onChange={({ checked }) => {
              selected.set(checked ? items.map((i) => i.id) : []);
              log(`Back up everything → ${checked}`);
            }}
            class={row}
            hoverStyle={hoverFill()}
            focusStyle={focusRing()}
            indicatorClass={indicator}
            indicatorStyle={box(all() || some())}
            indicator={mark()}
          >
            <Label label="Back up everything" detail={`${selected().length} of ${items.length} selected`} strong />
          </Checkbox>
          <Each of={items}>
            {(item) => (
              <>
                {line()}
                <Checkbox
                  checked={selected().includes(item().id)}
                  onChange={({ checked }) => {
                    selected.set(checked ? [...selected(), item().id] : selected().filter((id) => id !== item().id));
                    log(`${item().label} → ${checked}`);
                  }}
                  class={row}
                  hoverStyle={hoverFill()}
                  focusStyle={focusRing()}
                  indicatorClass={indicator}
                  indicatorStyle={box(selected().includes(item().id))}
                  indicator={mark()}
                >
                  <Label label={item().label} detail={item().detail} />
                </Checkbox>
              </>
            )}
          </Each>
        </View>

        <View style={{ ...ui().card, borderRadius: 16, overflow: "hidden" }}>
          <Checkbox checked disabled class={row} indicatorClass={indicator} indicatorStyle={box(true)} indicator={mark()}>
            <Label label="System settings" detail="Always backed up" />
          </Checkbox>
        </View>
      </Split>
    </View>
  );
}

mount(App);
