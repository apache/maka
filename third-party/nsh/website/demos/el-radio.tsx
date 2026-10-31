import { mount, signal, Text, View } from "nsh";
import { Radio, RadioGroup } from "nsh/base";
import { desktop, focusRing, hoverFill, Log, size, Split, ui } from "./palette";

const plans = [
  { id: "starter", label: "Starter", detail: "1 project · 5 GB", price: "Free" },
  { id: "pro", label: "Pro", detail: "Unlimited projects · 100 GB", price: "$12" },
  { id: "team", label: "Team", detail: "Shared workspace · 1 TB", price: "$40", locked: true },
];
const cycles = ["Monthly", "Yearly"];

function App() {
  const plan = signal("pro");
  const cycle = signal("Monthly");
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 3));
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>radio</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click an option, or Tab to a group and move with the arrow keys" : "Tap an option: its label checks it too"}
      </Text>

      <Split gap={14} inspector={<Log title={`onChange({ checked }) · ${plan()}, ${cycle()}`} lines={events()} minHeight={76} />}>
        {/* A segmented choice: each radio is a segment, `checkedStyle` raises the checked one. */}
        <RadioGroup style={{ flexDirection: "row", gap: 4, padding: 3, borderRadius: 10, ...ui().inset, ...(desktop ? { alignSelf: "flex-start" } : {}) }}>
          <Each of={cycles}>
            {(c) => (
              <Radio
                checked={cycle() === c()}
                onChange={({ checked }) => {
                  cycle.set(c());
                  log(`${c()} → ${checked}`);
                }}
                style={
                  desktop
                    ? { height: 26, paddingHorizontal: 14, borderRadius: 7, alignItems: "center", justifyContent: "center" }
                    : { flex: 1, height: 30, borderRadius: 7, alignItems: "center", justifyContent: "center" }
                }
                class="active:opacity-70"
                hoverStyle={cycle() === c() ? undefined : hoverFill()}
                focusStyle={focusRing()}
                checkedStyle={ui().raised}
              >
                <Text style={{ fontSize: 13, fontWeight: "500", color: cycle() === c() ? ui().text : ui().muted }}>{c()}</Text>
              </Radio>
            )}
          </Each>
        </RadioGroup>

        {/* A list of options: a ring with a dot, which `group-checked:` grows in (in place with reduced motion). */}
        <RadioGroup style={{ ...ui().card, borderRadius: 14, overflow: "hidden" }}>
          <Each of={plans}>
            {(item, i) => (
              <>
                {i() > 0 ? <View style={{ height: 1, marginLeft: desktop ? 40 : 48, backgroundColor: ui().line }} /> : null}
                <Radio
                  checked={plan() === item().id}
                  disabled={item().locked}
                  onChange={({ checked }) => {
                    plan.set(item().id);
                    log(`${item().label} → ${checked}`);
                  }}
                  class={`group flex-row items-center gap-3 ${desktop ? "px-3 py-2" : "px-4 py-3"} active:opacity-70 disabled:opacity-40`}
                  hoverStyle={item().locked ? undefined : hoverFill()}
                  focusStyle={focusRing()}
                >
                  <View
                    class="transition-colors motion-reduce:transition-none"
                    style={{
                      width: desktop ? 16 : 20,
                      height: desktop ? 16 : 20,
                      borderRadius: desktop ? 8 : 10,
                      borderWidth: 2,
                      borderColor: plan() === item().id ? ui().accent : ui().faint,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <View
                      class="opacity-0 scale-50 transition duration-150 ease-out motion-reduce:transition-none group-checked:opacity-100 group-checked:scale-100"
                      style={{ width: desktop ? 8 : 10, height: desktop ? 8 : 10, borderRadius: desktop ? 4 : 5, backgroundColor: ui().accent }}
                    />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: size.label, fontWeight: "500", color: ui().text }}>{item().label}</Text>
                    <Text style={{ fontSize: size.detail, color: ui().muted }}>{item().detail}</Text>
                  </View>
                  <Text style={{ fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"], color: ui().text }}>{item().price}</Text>
                </Radio>
              </>
            )}
          </Each>
        </RadioGroup>
      </Split>
    </View>
  );
}

mount(App);
