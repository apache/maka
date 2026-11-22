import { Canvas, cleanup, effect, keymap, lifecycle, signal, Text, View, type KeyEvent, type ViewRef } from "nsh";
import { Input } from "nsh/base";
import { alpha, Badge, Button, Caption, Card, colors, DemoPage, focusRing, hint, Icon, insetSurface, inputLook, mono, radius, Stat, TERMINAL_ROW, terminal } from "../ui";

// The shared keyboard API, shown four ways: keys that drive a canvas, a
// terminal-like surface that inspects them, a child that captures while its
// parent observes, and a native Input that keeps its editing inside all of
// it. `captureKeys` is the mounted policy the platform reads before native
// defaults run; `defaultPrevented` reports that decision on each transition.
// It is not a callback that could veto natively from JS: both listeners hear
// every transition, the capture decision included.

const TAU = Math.PI * 2;
/** `⌘` on Apple platforms, `Ctrl` elsewhere: the chord labels' vocabulary. */
const APPLE = keymap.label("mod+a").startsWith("⌘");
const MOD = APPLE ? "⌘" : "Ctrl";
const OPTION = APPLE ? "⌥" : "Alt";

/** The canvas puck's speed in points a second, whichever arrows are held. */
const SPEED = 230;
/** The room the puck keeps from the playfield's edge. */
const MARGIN = 26;
/** The most trail points kept: about a fifth of a second at 60 Hz. */
const TRAIL = 16;

const ARROWS = {
  ArrowLeft: { x: -1, y: 0, glyph: "←" },
  ArrowUp: { x: 0, y: -1, glyph: "↑" },
  ArrowDown: { x: 0, y: 1, glyph: "↓" },
  ArrowRight: { x: 1, y: 0, glyph: "→" },
} as const;
const ARROW_KEYS = Object.keys(ARROWS) as (keyof typeof ARROWS)[];

const arrow = (key: string) => (Object.prototype.hasOwnProperty.call(ARROWS, key) ? ARROWS[key as keyof typeof ARROWS] : undefined);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** A key as a person reads it: the space bar types " ", which words hide. */
const keyName = (key: string) => (key === " " ? "Space" : key === "" ? "—" : key);
const codeName = (code: string) => (code === "" ? "—" : code);

/** A keycap of the custom surface: lit while its key or modifier is held. */
function Keycap(props: { label: string; name?: string; down?: boolean; wide?: boolean }) {
  return (
    <View
      accessibilityLabel={props.name ?? props.label}
      style={{
        minWidth: props.wide ? 56 : 32,
        height: terminal ? TERMINAL_ROW : 28,
        paddingHorizontal: terminal ? 0 : 8,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: terminal ? 0 : radius.control,
        borderWidth: terminal ? 0 : 1,
        borderColor: props.down ? colors.accent : colors.border,
        backgroundColor: props.down ? alpha(colors.accent, 0.16) : colors.raised,
        transitionProperty: "colors",
        transitionDuration: 120,
      }}
    >
      <Text
        style={{
          fontSize: 12,
          fontWeight: "600",
          fontFamily: mono,
          color: props.down ? colors.accent : colors.muted,
          numberOfLines: 1,
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}

/** The four arrows as keycaps, lit for the ones in `held`. */
function ArrowChips(props: { held: string[] }) {
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      {ARROW_KEYS.map((key) => (
        <Keycap label={ARROWS[key].glyph} name={key} down={props.held.includes(key)} />
      ))}
    </View>
  );
}

/** One inspector row: a muted label and a monospaced value. */
function InspectRow(props: { label: string; value: string; tone?: "accent" | "text" | "muted" }) {
  const color = () => (props.tone === "accent" ? colors.accent : props.tone === "text" ? colors.text : colors.muted);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: terminal ? TERMINAL_ROW : 22 }}>
      <Text style={{ width: 116, fontSize: 12, color: colors.muted }}>{props.label}</Text>
      <Text style={{ flex: 1, fontSize: 12.5, fontFamily: mono, color: color(), textAlign: "right", numberOfLines: 1 }}>{props.value}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Held arrows: a canvas puck that moves while its arrows are held. The held
// set is the app's: a press adds an arrow, a release removes it, auto-repeat
// only counts, and losing the focus releases everything.

function HeldArrows() {
  let field: ViewRef | undefined;
  const held = signal<string[]>([]);
  const repeats = signal(0);
  const focused = signal(false);
  // Bumped whenever the drawing changes; it is read in `draw`, so the canvas
  // redraws without the demo's JSX.
  const frame = signal(0);
  const pos = { x: 0.5, y: 0.52 };
  let trail: { x: number; y: number }[] = [];
  let size = { width: 0, height: 0 };
  let raf: number | undefined;
  let last = 0;

  const direction = () => {
    let dx = 0;
    let dy = 0;
    for (const key of held()) {
      const d = arrow(key);
      if (d) {
        dx += d.x;
        dy += d.y;
      }
    }
    return { x: dx, y: dy };
  };

  const step = (now: number) => {
    raf = undefined;
    if (held().length === 0) {
      last = 0;
      return;
    }
    const dt = last === 0 ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
    last = now;
    const d = direction();
    const length = Math.hypot(d.x, d.y);
    if (length > 0) {
      // A fixed speed in points: diagonal movement is not faster, and a
      // narrow or wide playfield does not change it.
      const width = Math.max(1, size.width - 2 * MARGIN);
      const height = Math.max(1, size.height - 2 * MARGIN);
      pos.x = clamp(pos.x + ((d.x / length) * SPEED * dt) / width, 0, 1);
      pos.y = clamp(pos.y + ((d.y / length) * SPEED * dt) / height, 0, 1);
    }
    trail.push({ x: pos.x, y: pos.y });
    if (trail.length > TRAIL) trail.shift();
    frame.update((n) => n + 1);
    raf = requestAnimationFrame(step);
  };

  const kick = () => {
    if (raf === undefined) {
      last = 0;
      raf = requestAnimationFrame(step);
    }
  };

  /** Stops the frame loop and drops every held arrow (a blur or disposal). */
  const releaseAll = () => {
    held.set([]);
    trail = [];
    frame.update((n) => n + 1);
    if (raf !== undefined) {
      cancelAnimationFrame(raf);
      raf = undefined;
    }
  };

  const down = (e: KeyEvent) => {
    if (!arrow(e.key)) return;
    // An auto-repeat says the key is still held; the set already has it, so
    // repeats never add speed. They are only counted.
    if (e.repeat) {
      repeats.update((n) => n + 1);
      return;
    }
    if (!held().includes(e.key)) {
      held.update((list) => [...list, e.key]);
      frame.update((n) => n + 1);
      kick();
    }
  };

  const up = (e: KeyEvent) => {
    if (!arrow(e.key) || !held().includes(e.key)) return;
    held.update((list) => list.filter((key) => key !== e.key));
    frame.update((n) => n + 1);
  };

  cleanup(() => {
    if (raf !== undefined) {
      cancelAnimationFrame(raf);
      raf = undefined;
    }
  });

  // Another window or app took the focus: no releases arrive, so the app
  // releases what it held. (A view blur does the same for the same window.)
  effect(() => {
    if (lifecycle() !== "active") releaseAll();
  });

  return (
    <Card
      icon="canvas"
      title="Held arrows"
      subtitle="A canvas puck moves while its arrows are held"
      right={<Badge label={focused() ? "focused" : hint("tap to focus", "click to focus")} tone={focused() ? "accent" : "neutral"} />}
    >
      <View
        ref={(node) => (field = node)}
        onPress={() => field?.focus()}
        onFocus={() => focused.set(true)}
        onBlur={() => {
          focused.set(false);
          releaseAll();
        }}
        onKeyDown={down}
        onKeyUp={up}
        captureKeys={["left", "right", "up", "down"]}
        focusable
        accessibilityLabel="Playfield"
        testID="keyboard-playfield"
        focusVisibleStyle={focusRing()}
        style={{
          height: 208,
          borderRadius: radius.inset,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: focused() ? colors.accent : colors.border,
          backgroundColor: colors.inset,
          overflow: "hidden",
          cursor: "pointer",
          transitionProperty: "colors",
          transitionDuration: 160,
        }}
      >
        <Canvas
          style={{ width: "100%", height: "100%", pointerEvents: "none" }}
          draw={(cx, { width, height }) => {
            size = { width, height };
            // Read in the drawing: each frame's bump redraws the canvas.
            frame();
            const focusedNow = focused();
            const heldNow = held();

            cx.fillStyle = alpha(colors.text, 0.07);
            for (let x = 12; x < width; x += 20) {
              for (let y = 12; y < height; y += 20) {
                cx.beginPath();
                cx.arc(x, y, 1, 0, TAU);
                cx.fill();
              }
            }

            const innerX = MARGIN - 14;
            const innerY = MARGIN - 14;
            const innerW = width - 2 * innerX;
            const innerH = height - 2 * innerY;
            if (innerW > 0 && innerH > 0) {
              cx.strokeStyle = focusedNow ? alpha(colors.accent, 0.55) : colors.line;
              cx.lineWidth = 1;
              cx.beginPath();
              cx.roundRect(innerX, innerY, innerW, innerH, 12);
              cx.stroke();
              // The middle crosshair, for reading the puck's place.
              cx.setLineDash([2, 5]);
              cx.strokeStyle = alpha(colors.text, 0.1);
              cx.beginPath();
              cx.moveTo(width / 2, innerY + 6);
              cx.lineTo(width / 2, innerY + innerH - 6);
              cx.moveTo(innerX + 6, height / 2);
              cx.lineTo(innerX + innerW - 6, height / 2);
              cx.stroke();
              cx.setLineDash([]);
            }

            const at = (p: { x: number; y: number }) => ({
              x: MARGIN + p.x * Math.max(0, width - 2 * MARGIN),
              y: MARGIN + p.y * Math.max(0, height - 2 * MARGIN),
            });

            trail.forEach((point, i) => {
              const p = at(point);
              cx.globalAlpha = ((i + 1) / trail.length) * 0.3;
              cx.fillStyle = colors.accent;
              cx.beginPath();
              cx.arc(p.x, p.y, 1.5 + (i / trail.length) * 3, 0, TAU);
              cx.fill();
            });
            cx.globalAlpha = 1;

            const puck = at(pos);
            const d = direction();
            const moving = d.x !== 0 || d.y !== 0;
            cx.save();
            cx.shadowColor = alpha(colors.accent, focusedNow ? 0.6 : 0.32);
            cx.shadowBlur = focusedNow ? 18 : 9;
            cx.fillStyle = heldNow.length > 0 ? colors.accentFill : colors.accent;
            cx.beginPath();
            cx.arc(puck.x, puck.y, 9.5, 0, TAU);
            cx.fill();
            cx.restore();
            cx.strokeStyle = alpha(colors.accent, 0.5);
            cx.lineWidth = 1.5;
            cx.beginPath();
            cx.arc(puck.x, puck.y, 13.5, 0, TAU);
            cx.stroke();

            if (moving) {
              cx.save();
              cx.translate(puck.x, puck.y);
              cx.rotate(Math.atan2(d.y, d.x));
              cx.fillStyle = colors.onAccent;
              cx.beginPath();
              cx.moveTo(4.5, 0);
              cx.lineTo(-2.5, -3.6);
              cx.lineTo(-2.5, 3.6);
              cx.closePath();
              cx.fill();
              cx.restore();
            } else {
              cx.fillStyle = colors.onAccent;
              cx.beginPath();
              cx.arc(puck.x, puck.y, 2.2, 0, TAU);
              cx.fill();
            }
          }}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Button label="Start" onPress={() => field?.focus()} />
        <Text style={{ flex: 1, fontSize: 13, color: colors.muted, numberOfLines: 2 }}>
          {focused() ? "Listening: hold an arrow to move the puck." : hint("Tap the field, then hold an arrow", "Click the field or press Start, then hold an arrow")}
        </Text>
      </View>
      <View style={{ flexDirection: "row" }}>
        <Stat width="50%" label="Held" value={held().map((key) => (arrow(key) ? arrow(key)!.glyph : key)).join(" ") || "—"} />
        <Stat width="50%" label="Repeats ignored" value={String(repeats())} />
      </View>
      <Caption
        label="A press adds one arrow, a release removes it: auto-repeat changes neither."
        note={`${SPEED} pt/s`}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Modifier chords: a terminal-like surface of real keys, the held modifiers
// lit, and the last transition's key, code, repeat flag and capture decision.

type Snapshot = {
  key: string;
  code: string;
  repeat: boolean;
  defaultPrevented: boolean;
  modifiers: KeyEvent["modifiers"];
  phase: "down" | "up";
};

const CHORDS = ["mod+shift+y", "shift+space", "alt+enter"] as const;
/** Captured named keys and chords. Tab is left out: it still moves the focus. */
const CAPTURES = [...CHORDS, "space", "enter", "left", "right", "up", "down"] as const;
const CAPTURE_TEXT = `captureKeys={${JSON.stringify(CAPTURES)}}`;

function ModifierChords() {
  let panel: ViewRef | undefined;
  const last = signal<Snapshot | null>(null);
  const held = signal<string[]>([]);
  const transitions = signal(0);
  const prevented = signal(0);
  const focused = signal(false);

  const record = (e: KeyEvent, phase: "down" | "up") => {
    last.set({ key: e.key, code: e.code, repeat: e.repeat, defaultPrevented: e.defaultPrevented, modifiers: { ...e.modifiers }, phase });
    transitions.update((n) => n + 1);
    if (e.defaultPrevented) prevented.update((n) => n + 1);
  };

  const down = (e: KeyEvent) => {
    record(e, "down");
    if (!e.repeat && !held().includes(e.key)) held.update((list) => [...list, e.key]);
  };

  const up = (e: KeyEvent) => {
    record(e, "up");
    held.update((list) => list.filter((key) => key !== e.key));
  };

  // No releases arrive while another app has the focus; drop the lit keys.
  effect(() => {
    if (lifecycle() === "active") return;
    held.set([]);
    last.set(null);
  });

  const modifiers = () =>
    focused() && lifecycle() === "active"
      ? (last()?.modifiers ?? { control: false, alt: false, shift: false, platform: false })
      : { control: false, alt: false, shift: false, platform: false };
  // The shortcut modifier the chords use: Command on Apple platforms,
  // Control elsewhere. `platform` is Super / Windows there.
  const modDown = () => (APPLE ? modifiers().platform : modifiers().control);
  const pressed = (name: string, code?: string) => last()?.phase === "down" && ((code != null && code !== "" && last()!.code === code) || last()!.key.toLowerCase() === name.toLowerCase());
  const heldKey = (name: string) => held().some((key) => key.toLowerCase() === name.toLowerCase());

  return (
    <Card
      icon="terminal"
      title="Modifier chords"
      subtitle="A terminal-like key surface and its capture decision"
      right={<Badge label={focused() ? "listening" : hint("tap to focus", "click to focus")} tone={focused() ? "accent" : "neutral"} />}
    >
      <View
        ref={(node) => (panel = node)}
        onPress={() => panel?.focus()}
        onFocus={() => focused.set(true)}
        onBlur={() => {
          focused.set(false);
          held.set([]);
          last.set(null);
        }}
        onKeyDown={down}
        onKeyUp={up}
        captureKeys={CAPTURES}
        focusable
        accessibilityLabel="Key inspector"
        testID="keyboard-inspector"
        focusVisibleStyle={focusRing()}
        style={{ ...insetSurface(), overflow: "hidden" }}
      >
        <View
          style={{
            height: terminal ? TERMINAL_ROW : 30,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 10,
            backgroundColor: colors.raised,
            borderBottomWidth: 1,
            borderBottomColor: colors.line,
          }}
        >
          <If when={!terminal}>
            <View style={{ flexDirection: "row", gap: 4 }}>
              {[colors.danger, colors.warn, colors.up].map((tint) => (
                <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: tint }} />
              ))}
            </View>
          </If>
          <Icon name="terminal" size={13} tint={colors.muted} />
          <Text style={{ flex: 1, fontSize: 11.5, fontFamily: mono, color: colors.muted, numberOfLines: 1 }}>keys — live</Text>
          <Text style={{ fontSize: 11, color: colors.faint, fontFamily: mono, fontVariant: ["tabular-nums"] }}>{`${prevented()} captured`}</Text>
        </View>
        <View style={{ padding: 12, gap: 12 }}>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            <Keycap label={MOD} name="Modifier" down={modDown()} wide />
            <Keycap label={APPLE ? "⇧" : "Shift"} name="Shift" down={modifiers().shift} wide={!APPLE} />
            <Keycap label={OPTION} name="Alt" down={modifiers().alt} wide={APPLE} />
            <If when={!APPLE}>
              <Keycap label="Super" name="Platform key" down={modifiers().platform} wide />
            </If>
            <Keycap label="Y" name="Y" down={pressed("y", "KeyY")} />
            <Keycap label="Space" name="Space" down={heldKey(" ")} wide />
            <Keycap label="Enter" name="Enter" down={heldKey("Enter")} wide />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={{ width: 116, fontSize: 12, color: colors.muted }}>Held arrows</Text>
            <ArrowChips held={held()} />
          </View>
          <View style={{ height: 1, backgroundColor: colors.line }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, fontSize: 11.5, fontFamily: mono, color: colors.faint, numberOfLines: 2 }}>{last() ? `${last()!.phase} · ${transitions()} seen · ${prevented()} captured` : "no transition yet"}</Text>
            <Text style={{ fontSize: 11.5, color: colors.faint }}>{focused() ? "try Shift+Space" : hint("tap here, then press keys", "click here, then press keys")}</Text>
          </View>
          <InspectRow label="Key" value={last() ? keyName(last()!.key) : "—"} tone="text" />
          <InspectRow label="Code" value={last() ? codeName(last()!.code) : "—"} />
          <InspectRow label="Repeat" value={last() ? String(last()!.repeat) : "—"} />
          <InspectRow label="defaultPrevented" value={last() ? String(last()!.defaultPrevented) : "—"} tone={last()?.defaultPrevented ? "accent" : "muted"} />
          <Text style={{ fontSize: 10.5, fontFamily: mono, color: colors.faint, numberOfLines: 2 }}>{CAPTURE_TEXT}</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {CHORDS.map((chord) => (
          <View
            style={{
              height: terminal ? TERMINAL_ROW : 22,
              justifyContent: "center",
              paddingHorizontal: terminal ? 0 : 7,
              borderRadius: terminal ? 0 : radius.control,
              borderWidth: terminal ? 0 : 1,
              borderColor: colors.border,
              backgroundColor: colors.raised,
            }}
          >
            <Text style={{ fontSize: 11.5, fontFamily: mono, color: colors.muted }}>{keymap.label(chord)}</Text>
          </View>
        ))}
      </View>
      <Caption
        label="Chords above are captured; a plain A is not, and reports defaultPrevented false."
        note="Tab moves focus"
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Nested focus and bubbling: the child mounts a capture rule and handles its
// chords; the parent hears the same transitions and acts only where the
// mounted rule did not consume the key.

const CHILD_CAPTURES = ["mod+shift+y"] as const;
const CHILD_CAPTURE_TEXT = `captureKeys={${JSON.stringify(CHILD_CAPTURES)}}`;

function CaptureAndBubbling() {
  let child: ViewRef | undefined;
  const childFocus = signal(false);
  const childCount = signal(0);
  const parentCount = signal(0);
  const captured = signal(0);
  const acts = signal(0);
  const declined = signal(false);
  const action = signal("");
  const parentLog = signal<string[]>([]);

  const line = (e: KeyEvent, phase: "down" | "up") =>
    `${phase === "down" ? "↓" : "↑"} ${keyName(e.key)}${e.repeat ? " · repeat" : ""}${e.defaultPrevented ? " · captured" : ""}`;

  const childSees = (e: KeyEvent, phase: "down" | "up") => {
    childCount.update((n) => n + 1);
    if (phase === "down" && e.defaultPrevented) captured.update((n) => n + 1);
  };
  const parentSees = (e: KeyEvent, phase: "down" | "up") => {
    parentCount.update((n) => n + 1);
    parentLog.update((list) => [line(e, phase), ...list].slice(0, 3));
    if (phase !== "down" || e.repeat) return;
    if (e.defaultPrevented) {
      // The child's mounted rule decided this transition; the parent still
      // heard it, and elects not to act.
      declined.set(true);
      action.set("");
    } else if (e.key === "Enter") {
      declined.set(false);
      action.set("Acted on Enter");
      acts.update((n) => n + 1);
    } else {
      declined.set(false);
      action.set(`Observed ${keyName(e.key)} (no action)`);
    }
  };

  return (
    <Card
      icon="nav"
      title="Capture and bubbling"
      subtitle="A child capture, a parent listener, and one bubble each"
      right={<Badge label={childFocus() ? "child focused" : "focus the child"} tone={childFocus() ? "accent" : "neutral"} />}
    >
      <View
        onKeyDown={(e) => parentSees(e, "down")}
        onKeyUp={(e) => parentSees(e, "up")}
        style={{ gap: 12 }}
        testID="keyboard-parent"
      >
        <View style={{ flexDirection: "row", paddingHorizontal: 4 }}>
          <Stat width="34%" label="Child saw" value={String(childCount())} />
          <Stat width="33%" label="Parent saw" value={String(parentCount())} />
          <Stat width="33%" label="Captured" value={String(captured())} tone={captured() > 0 ? "accent" : undefined} />
        </View>
        <View
          ref={(node) => (child = node)}
          onPress={() => child?.focus()}
          onFocus={() => childFocus.set(true)}
          onBlur={() => childFocus.set(false)}
          onKeyDown={(e) => childSees(e, "down")}
          onKeyUp={(e) => childSees(e, "up")}
          captureKeys={CHILD_CAPTURES}
          focusable
          accessibilityLabel="Child capture"
          testID="keyboard-child"
          focusVisibleStyle={focusRing()}
          style={{
            ...insetSurface(),
            padding: 12,
            gap: 6,
            borderColor: childFocus() ? colors.accent : colors.border,
            cursor: "pointer",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="button" size={15} tint={colors.muted} />
            <Text style={{ flex: 1, fontSize: 13, fontWeight: "600", color: colors.text }}>Child capture</Text>
            <Badge label="captureKeys" outline />
          </View>
          <Text style={{ fontSize: 11.5, fontFamily: mono, color: colors.faint, numberOfLines: 2 }}>{CHILD_CAPTURE_TEXT}</Text>
          <Text style={{ fontSize: 12.5, color: colors.muted, numberOfLines: 2 }}>
            {childFocus() ? "Mod+Shift+Y is captured by the child; Enter lets the parent act." : hint("Tap to focus the child", "Click to focus the child")}
          </Text>
        </View>
        <View style={{ ...insetSurface(), padding: 12, gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, fontSize: 12, fontWeight: "600", color: colors.muted }}>Parent</Text>
            <Text style={{ fontSize: 11, fontFamily: mono, color: colors.faint }}>onKeyDown · onKeyUp</Text>
          </View>
          <Text style={{ fontSize: 13, color: declined() ? colors.accent : colors.text, numberOfLines: 2 }}>
            {declined() ? "Parent did not act: defaultPrevented" : action() || "Parent waits for a key"}
          </Text>
          <View style={{ gap: 3 }}>
            <If when={parentLog().length > 0} else={<Text style={{ fontSize: 11.5, fontFamily: mono, color: colors.faint }}>No transitions yet</Text>}>
              {parentLog().map((entry) => (
                <Text style={{ fontSize: 11.5, fontFamily: mono, color: colors.muted, numberOfLines: 1 }}>{entry}</Text>
              ))}
            </If>
          </View>
          <Text style={{ fontSize: 11.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`Parent actions: ${acts()}`}</Text>
        </View>
      </View>
      <Caption
        label="Both listeners hear every transition once, the captured ones included: defaultPrevented is the mounted rule's decision, not a callback veto."
        note="bubbles once"
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A native Input inside a capture ancestry: the ancestor takes Space, Enter
// and Mod+Shift+Y from a custom pad, while the Input keeps its editing, text
// and composition.

const INPUT_ANCESTRY = ["space", "enter", "mod+shift+y", "shift+space", "left", "right", "up", "down"] as const;

function TypingStaysInInput() {
  let raw: ViewRef | undefined;
  const rawFocus = signal(false);
  const rawCount = signal(0);
  const prevented = signal(0);
  const lastRaw = signal("");
  const text = signal("");

  const down = (e: KeyEvent) => {
    rawCount.update((n) => n + 1);
    lastRaw.set(keyName(e.key));
    if (e.defaultPrevented) prevented.update((n) => n + 1);
  };

  return (
    <Card
      icon="form"
      title="Typing stays in Input"
      subtitle="A capture rule around a native field"
      right={<Badge label={rawFocus() ? "raw pad focused" : "input owns keys"} tone={rawFocus() ? "accent" : "neutral"} />}
    >
      <View onKeyDown={down} captureKeys={INPUT_ANCESTRY} style={{ gap: 12 }} testID="keyboard-ancestry">
        <Text style={{ fontSize: 11.5, fontFamily: mono, color: colors.faint, numberOfLines: 2 }}>{`captureKeys={${JSON.stringify(INPUT_ANCESTRY)}}`}</Text>
        <View style={{ flexDirection: "row", paddingHorizontal: 4 }}>
          <Stat width="34%" label="Raw actions" value={String(rawCount())} />
          <Stat width="33%" label="Prevented" value={String(prevented())} tone={prevented() > 0 ? "accent" : undefined} />
          <Stat width="33%" label="Input characters" value={String(text().length)} />
        </View>
        <View
          ref={(node) => (raw = node)}
          onPress={() => raw?.focus()}
          onFocus={() => rawFocus.set(true)}
          onBlur={() => rawFocus.set(false)}
          focusable
          accessibilityLabel="Raw pad"
          testID="keyboard-raw"
          focusVisibleStyle={focusRing()}
          style={{
            ...insetSurface(),
            padding: 12,
            gap: 4,
            borderColor: rawFocus() ? colors.accent : colors.border,
            cursor: "pointer",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="button" size={15} tint={colors.muted} />
            <Text style={{ flex: 1, fontSize: 13, fontWeight: "600", color: colors.text }}>Raw pad</Text>
            <Text style={{ fontSize: 11.5, color: colors.faint, fontFamily: mono, numberOfLines: 1 }}>{lastRaw() ? `last ${lastRaw()}` : "no keys yet"}</Text>
          </View>
          <Text style={{ fontSize: 12.5, color: colors.muted, numberOfLines: 2 }}>
            {rawFocus() ? "Listening: Space, Enter and Mod+Shift+Y are captured here." : hint("Tap to focus the pad", "Click to focus the pad")}
          </Text>
        </View>
        <Input
          {...inputLook()}
          value={text()}
          onChange={({ value }) => text.set(value)}
          placeholder="Type here"
          accessibilityLabel="Type here"
          testID="keyboard-input"
        />
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <Text style={{ width: 116, fontSize: 12, color: colors.muted }}>Value</Text>
          <Text style={{ flex: 1, fontSize: 12.5, fontFamily: mono, color: colors.text, numberOfLines: 2 }}>{text() || "—"}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="check" size={14} tint={colors.up} />
          <Text style={{ fontSize: 12.5, fontWeight: "500", color: colors.up, numberOfLines: 1 }}>Input owns its text</Text>
        </View>
      </View>
      <Caption
        label="Typing in the field updates its value and never the raw actions; composition stays with Input."
        note="no interception"
      />
    </Card>
  );
}

/** The Keyboard demo: the shared key API's four surfaces. */
export function KeyboardDemo() {
  return (
    <DemoPage cards={[HeldArrows, ModifierChords, CaptureAndBubbling, TypingStaysInInput]} />
  );
}
