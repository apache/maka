import { Canvas, computed, Scroll, signal, Text, View } from "nsh";
import { createAnimatedValue, type AnimatedValue } from "nsh";
import { windowSize } from "nsh";
import { Icon } from "../icons";
import { Appear, Badge, colors, finish, hint, IconTile, mono, radius, Segmented, Stat, tints } from "../ui";

const CARD = 128;
/** Windows shorter than this scroll the demo, with the stage this tall:
 * below it the stage and the controls under it no longer fit. */
const SHORT_WINDOW = 640;
const SHORT_STAGE = 300;
/** Spring settings the release uses. */
const feels = {
  soft: { stiffness: 90, damping: 12 },
  bouncy: { stiffness: 180, damping: 11 },
  firm: { stiffness: 420, damping: 32 },
} as const;
type Feel = keyof typeof feels;
type Mode = "spring" | "coast" | "snap";

/**
 * A card dragged on the UI thread (`pan`) and released into a spring, a
 * decay or the nearest corner, with the drag's velocity. A canvas draws a
 * tether to it from the same animated values, without JS.
 */
export function Physics() {
  const x = createAnimatedValue(0);
  const y = createAnimatedValue(0);
  const pressed = createAnimatedValue(0);
  const lift = createAnimatedValue(0);
  const mode = signal<Mode>("spring");
  const feel = signal<Feel>("bouncy");
  const stage = signal({ width: 0, height: 0 });
  const releases = signal(0);
  const speed = signal(0);
  const corner = signal("—");

  const settle = (v: AnimatedValue, to: number, velocity: number) => v.spring(to, { velocity, ...feels[feel()] });
  const corners = () => ({ x: Math.max(0, stage().width / 2 - CARD / 2 - 14), y: Math.max(0, stage().height / 2 - CARD / 2 - 14) });

  const release = (e: { velocityX: number; velocityY: number; valueX?: number; valueY?: number }) => {
    lift.spring(0, { stiffness: 300, damping: 24 });
    releases.set(releases() + 1);
    speed.set(Math.round(Math.hypot(e.velocityX, e.velocityY)));
    switch (mode()) {
      case "spring":
        settle(x, 0, e.velocityX);
        settle(y, 0, e.velocityY);
        corner.set("—");
        break;
      case "coast":
        // Coast with the release velocity, then spring home unless grabbed again.
        x.decay({ velocity: e.velocityX, deceleration: 0.992 }).then((done) => done && settle(x, 0, 0));
        y.decay({ velocity: e.velocityY, deceleration: 0.992 }).then((done) => done && settle(y, 0, 0));
        corner.set("—");
        break;
      case "snap": {
        // Where the fling would carry it, then the nearest corner.
        const px = (e.valueX ?? 0) + e.velocityX * 0.2;
        const py = (e.valueY ?? 0) + e.velocityY * 0.2;
        const c = corners();
        settle(x, px < 0 ? -c.x : c.x, e.velocityX);
        settle(y, py < 0 ? -c.y : c.y, e.velocityY);
        corner.set(`${py < 0 ? "top" : "bottom"} ${px < 0 ? "left" : "right"}`);
        break;
      }
    }
  };
  const pulse = async () => {
    await pressed.timing(1, { duration: 120, easing: "easeOut" });
    await pressed.timing(0, { duration: 320, easing: "easeInOut" });
  };
  const reset = () => {
    releases.set(0);
    speed.set(0);
    corner.set("—");
    settle(x, 0, 0);
    settle(y, 0, 0);
  };
  const follow = [{ translateX: x }, { translateY: y }] as const;

  // Short windows scroll, with a stage of fixed height; the rest fills.
  const short = computed(() => windowSize().height < SHORT_WINDOW);
  const body = (short: boolean) => (
    <View style={short ? { padding: 16, gap: 12 } : { flex: 1, padding: 16, gap: 12, backgroundColor: colors.background }}>
      <Appear index={0}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <IconTile name="physics" tint={colors.accent} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text }}>Drag and release</Text>
            <Text numberOfLines={1} style={{ fontSize: 13, color: colors.muted }}>
              {hint("Tap to pulse, long press to reset", "Click to pulse, press and hold to reset")}
            </Text>
          </View>
          <Badge label="UI thread" tone="accent" />
        </View>
      </Appear>
      <View
        onLayout={(e) => stage.set({ width: e.size.width, height: e.size.height })}
        style={{
          flex: short ? undefined : 1,
          height: short ? SHORT_STAGE : undefined,
          overflow: "hidden",
          borderRadius: radius.card,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.inset,
          ...finish.inset,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Canvas
          pointerEvents="none"
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
          draw={(cx, { width, height }) => {
            const centerX = width / 2;
            const cy = height / 2;
            cx.fillStyle = colors.line;
            for (let gx = 10; gx < width; gx += 16) for (let gy = 10; gy < height; gy += 16) cx.fillRect(gx, gy, 1.5, 1.5);
            cx.setLineDash([3, 5]);
            cx.strokeStyle = colors.border;
            cx.lineWidth = 1;
            cx.beginPath();
            cx.moveTo(centerX, 0);
            cx.lineTo(centerX, height);
            cx.moveTo(0, cy);
            cx.lineTo(width, cy);
            cx.stroke();
            if (mode() === "snap") {
              const c = corners();
              cx.strokeStyle = colors.faint;
              for (const sx of [-1, 1])
                for (const sy of [-1, 1]) {
                  cx.beginPath();
                  cx.roundRect(centerX + sx * c.x - CARD / 2, cy + sy * c.y - CARD / 2, CARD, CARD, 26);
                  cx.stroke();
                }
            }
            cx.setLineDash([]);
            // The tether, from animated values: it follows drags and springs without JS.
            cx.strokeStyle = colors.accent;
            cx.globalAlpha = 0.45;
            cx.lineWidth = 1.5;
            cx.beginPath();
            cx.moveTo(centerX, cy);
            cx.lineTo(x.add(centerX), y.add(cy));
            cx.stroke();
            cx.globalAlpha = 1;
            cx.fillStyle = colors.accent;
            cx.beginPath();
            cx.arc(centerX, cy, 4, 0, Math.PI * 2);
            cx.fill();
          }}
        />
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            width: CARD,
            height: CARD,
            borderRadius: 30,
            backgroundColor: tints.accent,
            opacity: lift,
            transform: [...follow, { scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.32] }) }],
          }}
        />
        <View
          pan={{ x, y }}
          onPanStart={() => lift.spring(1, { stiffness: 400, damping: 26 })}
          onPanEnd={release}
          onPress={pulse}
          onLongPress={reset}
          role="button"
          accessibilityLabel="Draggable card"
          style={{
            width: CARD,
            height: CARD,
            borderRadius: 30,
            borderCurve: "continuous",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            backgroundColor: pressed.interpolate({ inputRange: [0, 1], outputRange: [colors.accentFill, colors.info] }),
            // The accent's highlight and glow; the color itself animates.
            boxShadow: finish.accent.boxShadow,
            transform: [
              ...follow,
              { scale: pressed.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) },
              { scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) },
              { rotate: x.interpolate({ inputRange: [-200, 200], outputRange: [-14, 14] }) },
            ],
          }}
        >
          <Icon name="gestures" size={28} tint={colors.onAccent} />
          <Text style={{ color: colors.onAccent, fontSize: 15, fontWeight: "700" }}>Drag me</Text>
        </View>
      </View>
      <View
        style={{
          backgroundColor: colors.surface,
          ...finish.card,
          borderRadius: radius.card,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.border,
          padding: 12,
          gap: 12,
        }}
      >
        <Segmented
          options={[
            { value: "spring", label: "Spring" },
            { value: "coast", label: "Coast" },
            { value: "snap", label: "Snap" },
          ]}
          value={mode()}
          onChange={(m) => mode.set(m)}
        />
        <Segmented
          size="small"
          options={[
            { value: "soft", label: "Soft" },
            { value: "bouncy", label: "Bouncy" },
            { value: "firm", label: "Firm" },
          ]}
          value={feel()}
          onChange={(f) => feel.set(f)}
        />
        <View style={{ flexDirection: "row", paddingHorizontal: 4 }}>
          <Stat width="30%" label="Releases" value={String(releases())} />
          <Stat width="34%" label="Speed" value={`${speed()} pt/s`} tone={speed() > 1500 ? "warn" : undefined} />
          <Stat width="36%" label={mode() === "snap" ? "Corner" : "Spring"} value={mode() === "snap" ? corner() : `${feels[feel()].stiffness} / ${feels[feel()].damping}`} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingHorizontal: 4 }}>
          <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>
            {mode() === "spring" ? "Springs home with the release velocity" : mode() === "coast" ? "Coasts to a stop, then springs home" : "Springs to the corner the fling points at"}
          </Text>
          <Text style={{ fontSize: 12, fontFamily: mono, color: colors.faint }}>{mode() === "coast" ? "decay" : "spring"}</Text>
        </View>
      </View>
    </View>
  );
  return (
    <If when={short()} else={body(false)}>
      <Scroll style={{ flex: 1, backgroundColor: colors.background }}>{body(true)}</Scroll>
    </If>
  );
}
