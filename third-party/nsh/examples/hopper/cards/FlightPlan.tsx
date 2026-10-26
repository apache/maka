import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { ceiling, flyHop, flying, type Hop, hoverThrottle, plan, resetPlan, segments } from "../store";
import { color, mono, radius } from "../theme";
import { Action, Caption, Counter, Line, Panel, Segmented, Slider, Switch } from "../ui";

type Axis = "x" | "y" | "z";

/** A target coordinate in meters; the field lights up while edited and
 * turns rose when the apogee is over the range's ceiling. */
function Coordinate(props: { axis: Axis; label: string; signed?: boolean }) {
  const focused = signal(false);
  const over = () => props.axis === "z" && Number(plan.target().z) > ceiling;
  return (
    <View style={{ flex: 1, gap: 6 }}>
      <Text style={{ fontSize: 12, color: over() ? color.alert : color.muted }}>{props.label}</Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          height: 44,
          paddingHorizontal: 12,
          borderRadius: radius.control,
          borderWidth: 1.5,
          borderColor: over() ? color.alert : focused() ? color.accent : color.line,
          backgroundColor: color.inset,
        }}
      >
        <Input
          value={plan.target()[props.axis]}
          onChange={(text) => {
            const minus = props.signed && text.startsWith("-") ? "-" : "";
            const digits = text.replace(/[^0-9]/g, "").slice(0, 3);
            plan.target.set({ ...plan.target(), [props.axis]: minus + digits });
          }}
          onFocus={() => focused.set(true)}
          onBlur={() => {
            focused.set(false);
            const v = plan.target()[props.axis];
            if (v === "" || v === "-") plan.target.set({ ...plan.target(), [props.axis]: "0" });
          }}
          keyboardType={props.signed ? "numbers-and-punctuation" : "number-pad"}
          returnKeyType="done"
          accessibilityLabel={`${props.label}, meters`}
          style={{ selectionColor: color.accent, flex: 1, fontFamily: mono, fontSize: 15, color: color.text, paddingVertical: 6 }}
        />
        <Text style={{ fontFamily: mono, fontSize: 13, color: color.faint }}>m</Text>
      </View>
    </View>
  );
}

function Option(props: { title: string; detail: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean; first?: boolean }) {
  return (
    <Line first={props.first}>
      <View style={{ flex: 1, gap: 2, paddingVertical: 10, opacity: props.disabled ? 0.5 : 1 }}>
        <Text style={{ fontSize: 15, color: color.text }}>{props.title}</Text>
        <Text style={{ fontSize: 12, color: color.muted }}>{props.detail}</Text>
      </View>
      <Switch value={props.value} onChange={props.onChange} disabled={props.disabled} label={props.title} />
    </Line>
  );
}

const results: Record<Hop["outcome"], { label: string; tint: string }> = {
  nominal: { label: "nominal", tint: color.accent },
  hard: { label: "hard landing", tint: color.caution },
  abort: { label: "aborted", tint: color.alert },
};

export function FlightPlan() {
  const last = signal<Hop | null>(null);
  const fly = async () => {
    last.set(null);
    last.set(await flyHop());
  };
  return (
    <Panel icon="plan" title="Flight plan" status="Hop profile · pad B">
      <Segmented options={segments} value={plan.segment()} onChange={(s) => plan.segment.set(s)} />

      <View style={{ gap: 10 }}>
        <Caption
          label="Throttle"
          value={`${plan.throttle()}%`}
          tint={plan.throttle() < hoverThrottle ? color.caution : color.text}
        />
        <Slider
          min={40}
          max={100}
          floor={hoverThrottle}
          unit="%"
          value={plan.throttle()}
          label="Throttle, percent"
          onChange={(v) => plan.throttle.set(v)}
        />
      </View>

      <View>
        <Line first>
          <Text style={{ flex: 1, fontSize: 15, color: color.text }}>Gimbal limit</Text>
          <Counter
            label="Gimbal limit"
            value={plan.gimbal()}
            format={(v) => `±${v}°`}
            step={1}
            min={2}
            max={12}
            onChange={(v) => plan.gimbal.set(v)}
          />
        </Line>
        <Line>
          <Text style={{ flex: 1, fontSize: 15, color: color.text }}>Hover time</Text>
          <Counter
            label="Hover time"
            value={plan.hoverTime()}
            format={(v) => `${v} s`}
            step={1}
            min={0}
            max={40}
            onChange={(v) => plan.hoverTime.set(v)}
          />
        </Line>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 14, color: color.muted }}>Target</Text>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Coordinate axis="x" label="East" signed />
          <Coordinate axis="y" label="North" signed />
          <Coordinate axis="z" label="Apogee" />
        </View>
        <If when={Number(plan.target().z) > ceiling}>
          <Text style={{ fontSize: 12, color: color.alert }}>The range's ceiling is {ceiling} m.</Text>
        </If>
      </View>

      <View>
        <Option
          first
          title="Terrain-relative navigation"
          detail="Lidar locks onto the pad below 40 m"
          value={plan.terrainNav()}
          onChange={(v) => plan.terrainNav.set(v)}
        />
        <Option title="Deploy legs at 30 m" detail="Earlier adds drag on descent" value={plan.legsAt30()} onChange={(v) => plan.legsAt30.set(v)} />
        <Option
          title="Abort on excess tilt"
          detail="Waiting for IMU calibration"
          value={plan.autoAbort()}
          onChange={(v) => plan.autoAbort.set(v)}
          disabled
        />
      </View>

      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Action label="Defaults" disabled={flying()} onPress={resetPlan} />
          <Action label={flying() ? "Flying…" : "Fly hop"} primary disabled={flying()} onPress={fly} />
        </View>
        <If when={last()}>
          <Text style={{ fontSize: 13, color: color.muted, textAlign: "center" }}>
            Hop {last()?.id}:{" "}
            <Text style={{ color: results[last()?.outcome ?? "nominal"].tint }}>{results[last()?.outcome ?? "nominal"].label}</Text> ·{" "}
            {last()?.note}
          </Text>
        </If>
      </View>
    </Panel>
  );
}
