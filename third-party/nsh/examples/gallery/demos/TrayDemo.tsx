import { type Bounds, cleanup, effect, type Point, type Size, signal, Text, View } from "nsh";
import { currentWindow, displays, isAvailable, Tray, type TrayClickEvent, Window, windowState } from "nsh/desktop";
import star from "../star.svg";
import { Button, Caption, Card, colors, DemoPage, IconTile, PopIn, Row, Status, Toggle } from "../ui";

/**
 * The tray panel's size, in points: its rows (the header's 36, the
 * setting's 31, the button's 28, 12 apart) 14 in from a 1-point edge. Its
 * texts keep their line heights, so at the standard text size it is this
 * tall on every platform.
 */
const PANEL: Size = { width: 288, height: 2 * (1 + 14) + 36 + 12 + 31 + 12 + 28 };
/** The room between the icon and the panel. */
const GAP = 6;

/**
 * `Tray` of `nsh/desktop`: the app's icon in the system tray with a
 * tooltip, a click and a menu. A click opens a panel next to the icon,
 * placed from the frame the click reports (macOS, Windows); where the
 * system reports no frame (Linux), it brings the gallery forward.
 */
export function TrayDemo() {
  // The window this demo shows in, kept for the menu's handler.
  const main = currentWindow();
  const shown = signal(false);
  const last = signal("Nothing yet");
  const muted = signal(false);
  /** The icon's frame the last click reported, as text. */
  const frame = signal<string | null>(null);
  /** Where the panel is, while it is open. */
  const panel = signal<Placement | null>(null);
  // When the panel last closed as the focus left it: a click on the icon
  // that took the focus (Windows' taskbar) leaves it closed.
  let closedAt = 0;
  const toggleMute = () => {
    muted.set(!muted());
    showTray();
    last.set(muted() ? "Muted" : "Sound on");
  };
  const clicked = ({ bounds }: TrayClickEvent) => {
    frame.set(bounds && describe(bounds));
    if (!bounds) {
      main.focus();
      last.set("Clicked the icon");
      return;
    }
    if (panel()) {
      panel.set(null);
      return;
    }
    if (Date.now() - closedAt < 400) return;
    panel.set(atIcon(bounds, PANEL));
    last.set("Opened the panel");
  };
  const showTray = () => {
    shown.set(true);
    Tray.set({
      icon: star,
      tooltip: "NSH Gallery",
      onClick: clicked,
      menu: [
        { label: "Open Gallery", onSelect: () => (main.focus(), last.set("Chose Open Gallery")) },
        { label: "Mute", checked: muted(), onSelect: toggleMute },
        { type: "separator" },
        { label: "More", submenu: [{ label: "About", onSelect: () => last.set("Chose About") }] },
        { label: "Remove icon", onSelect: () => hideTray() },
      ],
    });
  };
  const hideTray = () => {
    shown.set(false);
    panel.set(null);
    Tray.set(null);
  };
  cleanup(() => Tray.set(null));
  return (
    <DemoPage
      cards={[
        () => (
          <Card title="Tray icon" subtitle={isAvailable ? "Click it, or open its menu" : "Desktops only"}>
            <Row first>
              <Button label={shown() ? "Update" : "Show icon"} onPress={showTray} />
              <Button label="Remove" variant="ghost" onPress={hideTray} />
            </Row>
            <Caption label={last()} note={frame() ?? undefined} />
            {/* Opened by a click on the icon, next to it; it closes with this page. */}
            <Window
              id="tray-panel"
              kind="popup"
              transparent
              open={panel() !== null}
              onOpenChange={({ open, reason }) => {
                if (!open) {
                  panel.set(null);
                  if (reason === "blur") closedAt = Date.now();
                }
              }}
              defaultSize={PANEL}
              // As tall as its rows: taller with a larger text size.
              sizeToContent="height"
              defaultPosition={panel()?.at ?? "center"}
            >
              <TrayPanel
                below={panel()?.below ?? true}
                bottom={panel()?.bottom ?? null}
                muted={muted()}
                onMute={toggleMute}
                onOpen={() => {
                  panel.set(null);
                  main.focus();
                  last.set("Chose Open Gallery");
                }}
              />
            </Window>
          </Card>
        ),
      ]}
    />
  );
}

/** What a menu-bar app shows from its icon: its state, a setting and a way
 * to its window. Above the icon, its bottom edge stays at `bottom`. */
function TrayPanel(props: { below: boolean; bottom: number | null; muted: boolean; onMute: () => void; onOpen: () => void }) {
  const win = currentWindow();
  // The window takes its rows' height, taller with a larger text size:
  // above the icon, it moves up by as much.
  effect(() => {
    const bounds = windowState()?.bounds;
    if (!bounds || props.bottom === null) return;
    const y = props.bottom - bounds.size.height;
    if (Math.abs(bounds.origin.y - y) > 0.5) win.setBounds({ origin: { y } });
  });
  return (
    <PopIn side={props.below ? "bottom" : "top"} class="overflow-hidden rounded-xl border border-border bg-card" style={{ padding: 14, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <IconTile name="star" size={32} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: "600", color: colors.text }}>NSH Gallery</Text>
          <Text style={{ fontSize: 12, lineHeight: 16, color: colors.muted }}>Opened from the tray</Text>
        </View>
        <Status label={props.muted ? "Muted" : "Sound on"} tone={props.muted ? "neutral" : "up"} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: 1, borderColor: colors.border, paddingTop: 12 }}>
        <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: colors.text }}>Mute sounds</Text>
        <Toggle value={props.muted} onChange={() => props.onMute()} label="Mute sounds" />
      </View>
      <Button label="Open Gallery" icon="external" onPress={props.onOpen} />
    </PopIn>
  );
}

/** A frame as the caption shows it: its corner and size, in points. */
function describe(b: Bounds) {
  const n = (v: number) => Math.round(v);
  return `${n(b.origin.x)}, ${n(b.origin.y)} · ${n(b.size.width)} × ${n(b.size.height)}`;
}

/** Where the panel opens: its top left corner, the icon's side it is on,
 * and above the icon, the y its bottom edge keeps (`null` below it). */
type Placement = { at: Point; below: boolean; bottom: number | null };

/** Where a panel of `size` opens at the tray icon: centered on it, below it
 * on a menu bar at the top of its display, above it on a taskbar at the
 * bottom, kept in the display's visible area. */
function atIcon(icon: Bounds, size: Size): Placement {
  const inside = (b: Bounds, p: Point) =>
    p.x >= b.origin.x && p.x < b.origin.x + b.size.width && p.y >= b.origin.y && p.y < b.origin.y + b.size.height;
  const display = displays().find((d) => inside(d.bounds, icon.origin)) ?? displays()[0];
  if (!display) return { at: { x: icon.origin.x, y: icon.origin.y + icon.size.height + GAP }, below: true, bottom: null };
  const area = display.visibleBounds;
  const below = icon.origin.y < area.origin.y + area.size.height / 2;
  const x = icon.origin.x + (icon.size.width - size.width) / 2;
  const y = below ? icon.origin.y + icon.size.height + GAP : icon.origin.y - size.height - GAP;
  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
  const at = {
    x: clamp(x, area.origin.x, area.origin.x + area.size.width - size.width),
    y: clamp(y, area.origin.y, area.origin.y + area.size.height - size.height),
  };
  return { at, below, bottom: below ? null : at.y + size.height };
}
