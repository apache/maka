import { Text, View, type JSX } from "nsh";
import { Canvas } from "nsh";

export const palette = {
  page: "#0c131d", sidebar: "#101c28", panel: "#14212f", raised: "#1b2d3d", line: "#293e50",
  ink: "#dfebf4", muted: "#91a9bd", faint: "#617d93", mint: "#8bd6bd", amber: "#e3bc7e",
  blue: "#86afdb", violet: "#a8bad0", mintInk: "#102b25", selected: "#204039",
};

export function Label(props: { children: JSX.Element; color?: string; strong?: boolean; align?: "left" | "right"; lines?: number }) {
  return <Text style={{ numberOfLines: props.lines ?? 1, height: 16 * (props.lines ?? 1), fontSize: 14, lineHeight: 16, fontWeight: props.strong ? "600" : "400", color: props.color ?? palette.muted, textAlign: props.align ?? "left" }}>{props.children}</Text>;
}

export function Action(props: { label: string; onPress: () => void; testID: string; accessibilityLabel?: string; primary?: boolean; active?: boolean; width?: number }) {
  return (
    <View
      testID={props.testID}
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onPress={props.onPress}
      style={{ height: 16, width: props.width, paddingHorizontal: 8, justifyContent: "flex-start", backgroundColor: props.primary ? palette.mint : props.active ? palette.selected : palette.raised }}
    >
      <Label strong color={props.primary ? palette.mintInk : props.active ? palette.mint : palette.muted}>{props.label}</Label>
    </View>
  );
}

export function Sparkline(props: { seed: number; color: string; warning?: boolean }) {
  return (
    <Canvas
      style={{ width: 48, height: 16 }}
      draw={(ctx, { width, height }) => {
        ctx.strokeStyle = props.color;
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        ctx.beginPath();
        for (let index = 0; index < 12; index++) {
          const value = props.warning ? 0.2 + Math.abs(Math.sin(index * 1.6 + props.seed)) * 0.65 : 0.35 + Math.sin(index * 0.8 + props.seed) * 0.14;
          const x = index * width / 11;
          const y = height * (1 - value);
          if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }}
    />
  );
}

export function Metric(props: { title: string; value: string; detail: string; color: string; dense?: boolean }) {
  return (
    <View style={{ flex: 1, minWidth: 0, height: props.dense ? 32 : 48, paddingHorizontal: 8, backgroundColor: palette.panel }}>
      <View style={{ height: 16, flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Label>{props.title}</Label>
        <Label strong color={props.color}>{props.value}</Label>
      </View>
      <View style={{ height: 16 }} />
      <If when={!props.dense}><Label color={palette.faint}>{props.detail}</Label></If>
    </View>
  );
}

export function Progress(props: { label: string; value: number; color: string }) {
  return (
    <View style={{ height: 16, flexDirection: "row", gap: 8 }}>
      <View style={{ width: 56 }}><Label>{props.label}</Label></View>
      <View style={{ flex: 1, height: 16, backgroundColor: palette.raised }}>
        <View style={{ height: 16, width: `${props.value}%`, backgroundColor: props.color }} />
      </View>
      <View style={{ width: 32 }}><Label align="right" color={props.color}>{`${props.value}%`}</Label></View>
    </View>
  );
}
