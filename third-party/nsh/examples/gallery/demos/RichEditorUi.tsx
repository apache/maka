// The Rich Editor demo's toolbar controls and its Lucide icons, on the
// shared gallery UI's colors and finishes.
import { Canvas, type CanvasRenderingContext2D, Path2D, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { colors, finish, focusRing } from "../ui";
import { lucide, type LucideElement, type LucideName } from "../lucide";

/** The Lucide icons the Rich Editor demo draws (`lucide.ts`, made by `scripts/lucide.py`). */
export type LucideIconName = LucideName;

/** The numbers of an SVG `points` list, in pairs. */
function points(list: string): number[] {
  return list
    .trim()
    .split(/[\s,]+/)
    .map(Number);
}

/** Draws one element as Lucide's SVG does: stroked, never filled. */
function draw(cx: CanvasRenderingContext2D, el: LucideElement) {
  switch (el.tag) {
    case "path":
      cx.stroke(new Path2D(el.d));
      return;
    case "circle":
      cx.beginPath();
      cx.arc(el.cx, el.cy, el.r, 0, Math.PI * 2);
      break;
    case "ellipse":
      cx.beginPath();
      cx.ellipse(el.cx, el.cy, el.rx, el.ry, 0, 0, Math.PI * 2);
      break;
    case "rect":
      cx.beginPath();
      cx.roundRect(el.x, el.y, el.width, el.height, el.rx ?? 0);
      break;
    case "line":
      cx.beginPath();
      cx.moveTo(el.x1, el.y1);
      cx.lineTo(el.x2, el.y2);
      break;
    case "polyline":
    case "polygon": {
      const p = points(el.points);
      cx.beginPath();
      cx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) cx.lineTo(p[i], p[i + 1]);
      if (el.tag === "polygon") cx.closePath();
      break;
    }
  }
  cx.stroke();
}

/** A Lucide icon on its 24 × 24 grid, stroked with `tint` (width 2, round caps and joins). */
export function LucideIcon(props: { name: LucideIconName; size?: number; tint: string }) {
  const size = props.size ?? 20;
  return (
    <Canvas
      style={{ pointerEvents: "none", width: size, height: size }}
      draw={(cx, { width }) => {
        cx.scale(width / 24, width / 24);
        cx.strokeStyle = props.tint;
        cx.lineWidth = 2;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        for (const el of lucide[props.name] as LucideElement[]) draw(cx, el);
      }}
    />
  );
}

/** An item of a {@link ToggleGroup}: its icon, and the label screen readers say and its tooltip shows. */
export type ToggleItem<T extends string> = { value: T; icon: LucideIconName; label: string; disabled?: boolean };

/**
 * A row of icon toggles on one track (shadcn's toggle group): `single` keeps
 * at most one pressed, `multiple` any. Each toggle is `nsh/base`'s `Button`,
 * selected while pressed, so screen readers (and tests) read its state.
 */
export function ToggleGroup<T extends string>(props: {
  type: "single" | "multiple";
  items: readonly ToggleItem<T>[];
  /** The pressed values. */
  value: readonly T[];
  /** The value pressed or released, and whether it is now pressed. */
  onToggle: (value: T, pressed: boolean) => void;
  testID?: string;
}) {
  return (
    <View
      testID={props.testID}
      style={{ flexDirection: "row", padding: 2, gap: 2, borderRadius: 9, backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.border }}
    >
      <Each of={props.items}>
        {(item) => {
          const pressed = () => props.value.includes(item().value);
          return (
            <View tooltip={item().label}>
              <BaseButton
                selected={pressed()}
                disabled={item().disabled}
                accessibilityLabel={item().label}
                onPress={() => props.onToggle(item().value, !pressed())}
                hoverStyle={item().disabled || pressed() ? undefined : { backgroundColor: colors.raised }}
                focusStyle={focusRing(1)}
                style={{
                  width: 30,
                  height: 28,
                  borderRadius: 7,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: item().disabled ? 0.35 : 1,
                  ...(pressed() ? { ...finish.pill, borderWidth: 1 } : { borderWidth: 1, borderColor: "transparent" }),
                }}
              >
                <LucideIcon name={item().icon} size={16} tint={pressed() ? colors.text : colors.muted} />
              </BaseButton>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

/** A square icon button for toolbars: its label is what screen readers say and its tooltip. */
export function IconButton(props: { icon: LucideIconName; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View tooltip={props.label}>
      <BaseButton
        disabled={props.disabled}
        accessibilityLabel={props.label}
        onPress={props.onPress}
        hoverStyle={props.disabled ? undefined : { backgroundColor: colors.raised }}
        focusStyle={focusRing(1)}
        style={{ width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", opacity: props.disabled ? 0.35 : 1 }}
      >
        <LucideIcon name={props.icon} size={16} tint={colors.text} />
      </BaseButton>
    </View>
  );
}

/** A thin vertical line between a toolbar's groups. */
export function ToolbarSeparator() {
  return <View style={{ width: 1, height: 20, marginHorizontal: 4, backgroundColor: colors.border }} />;
}
