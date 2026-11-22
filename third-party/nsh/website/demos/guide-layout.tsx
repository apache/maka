import { mount, Scroll, signal, Text, View } from "nsh";
import { Toggle, ToggleGroup } from "nsh/base";
import { Inspector, Segmented, tint, toggleLabel, toggleLook, ui, wide } from "./palette";

type Direction = "column" | "row";
type Justify = "flex-start" | "center" | "flex-end" | "space-between" | "space-evenly";
type Align = "stretch" | "flex-start" | "center" | "flex-end";

/** A choice's toggles: small, each its value, on a field's edge while off. */
const chip = { size: "small", variant: "outline", text: true } as const;

/**
 * One of values too long for a segmented control's single row (five of
 * CSS's `justifyContent`): a toggle group that wraps, exactly one pressed.
 * Shorter choices are a `Segmented`.
 */
function Choice<T extends string>(props: { label: string; options: readonly T[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 12, color: ui().muted }}>{props.label}</Text>
      <ToggleGroup style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Each of={props.options}>
          {(o) => {
            const on = () => props.value === o();
            return (
              // Exactly one: the pressed value stays pressed.
              <Toggle pressed={on()} onChange={({ pressed }) => pressed && props.onChange(o())} {...toggleLook(chip)}>
                <Text style={toggleLabel(on, chip)}>{o()}</Text>
              </Toggle>
            );
          }}
        </Each>
      </ToggleGroup>
    </View>
  );
}

function App() {
  const direction = signal<Direction>("row");
  const justify = signal<Justify>("flex-start");
  const align = signal<Align>("stretch");
  const colors = () => [ui().down, ui().info, ui().up];

  const box = (height: number) => (
    <View
      style={{
        height,
        padding: 10,
        gap: 8,
        borderRadius: 12,
        ...ui().inset,
        flexDirection: direction(),
        justifyContent: justify(),
        alignItems: align(),
      }}
    >
      <Each of={colors()}>
        {(c, i) => (
          <View style={{ minWidth: 44, minHeight: 44, padding: 6, borderRadius: 8, backgroundColor: c() }}>
            <Text style={{ color: ui().page, fontWeight: "700" }}>{i() + 1}</Text>
          </View>
        )}
      </Each>
    </View>
  );
  const more = () => (
    <>
      <Text style={{ fontSize: 12, fontWeight: "600", color: ui().muted }}>flex: 1 / 2 / fixed, percentages, aspectRatio</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1, height: 36, borderRadius: 6, backgroundColor: tint(ui().info, 0.3) }} />
        <View style={{ flex: 2, height: 36, borderRadius: 6, backgroundColor: tint(ui().info, 0.6) }} />
        <View style={{ width: 36, height: 36, borderRadius: 6, backgroundColor: ui().info }} />
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
        <View style={{ width: "30%", aspectRatio: 1, borderRadius: 8, backgroundColor: tint(ui().warn, 0.35) }} />
        <View style={{ width: "40%", aspectRatio: 16 / 9, borderRadius: 8, backgroundColor: ui().warn }} />
      </View>

      <Text style={{ fontSize: 12, fontWeight: "600", color: ui().muted }}>grid</Text>
      <View style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        <View style={{ gridColumn: "span 2", height: 40, borderRadius: 6, backgroundColor: tint(ui().violet, 0.3) }} />
        <View style={{ height: 40, borderRadius: 6, backgroundColor: tint(ui().violet, 0.6) }} />
        <View style={{ gridRow: "span 2", borderRadius: 6, backgroundColor: ui().violet }} />
        <View style={{ gridColumn: "1 / 4", height: 40, borderRadius: 6, backgroundColor: tint(ui().violet, 0.8) }} />
      </View>

      <Text style={{ fontSize: 12, fontWeight: "600", color: ui().muted }}>position: absolute</Text>
      <View style={{ ...ui().inset, height: 100, borderRadius: 12 }}>
        <View style={{ position: "absolute", top: 8, left: 8, width: 60, height: 40, borderRadius: 6, backgroundColor: ui().up }} />
        <View style={{ position: "absolute", right: 8, bottom: 8, width: "40%", height: 30, borderRadius: 6, backgroundColor: ui().down }} />
        <View style={{ position: "absolute", top: 0, bottom: 0, left: "50%", width: 2, backgroundColor: ui().border }} />
      </View>
    </>
  );
  const justifyChoice = () => (
    <Choice
      label="justifyContent"
      options={["flex-start", "center", "flex-end", "space-between", "space-evenly"] as const}
      value={justify()}
      onChange={(v) => justify.set(v)}
    />
  );
  const directionChoice = () => (
    <Segmented label="flexDirection" options={["row", "column"] as const} value={direction()} onChange={(v) => direction.set(v)} />
  );
  const alignChoice = () => (
    <Segmented label="alignItems" options={["stretch", "flex-start", "center", "flex-end"] as const} value={align()} onChange={(v) => align.set(v)} />
  );

  return (
    <>
      {() =>
        wide() ? (
          <View style={{ flex: 1, backgroundColor: ui().page, flexDirection: "row", padding: 20, paddingTop: 24, gap: 16 }}>
            <Scroll style={{ flex: 1, minWidth: 0 }}>
              <View style={{ gap: 14 }}>
                {box(260)}
                {more()}
              </View>
            </Scroll>
            <Inspector>
              {directionChoice()}
              {justifyChoice()}
              {alignChoice()}
            </Inspector>
          </View>
        ) : (
          <Scroll style={{ flex: 1, backgroundColor: ui().page }}>
            <View style={{ padding: 20, paddingTop: 24, gap: 14 }}>
              {directionChoice()}
              {justifyChoice()}
              {alignChoice()}
              {box(220)}
              {more()}
            </View>
          </Scroll>
        )
      }
    </>
  );
}

mount(App);
