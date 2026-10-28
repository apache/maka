import { Overlay, signal, Text, View, type ViewRef } from "nsh";
import { Popover, Sheet, Tooltip } from "nsh/base";
import { dismissToast, toast } from "../toast";
import { platform } from "nsh";
import { Badge, Button, Caption, Card, colors, DemoPage, finish, mono, radius, Segmented, Tip } from "../ui";

/** The popups' look: the gallery's, as `nsh/base` draws none. */
const popup = () => ({
  backgroundColor: colors.raised,
  borderRadius: radius.inset,
  borderWidth: 1,
  borderColor: colors.border,
  padding: 6,
  minWidth: 180,
  ...finish.raised,
});

/** A sheet's panel: the bottom of the screen. */
const sheet = () => ({
  backgroundColor: colors.surface,
  borderTopLeftRadius: 20,
  borderTopRightRadius: 20,
  padding: 12,
  paddingBottom: 32,
  gap: 2,
});

const backdrop = { backgroundColor: "rgba(0,0,0,0.45)" };

/** A pressable chip that opens a popup. */
function Trigger(props: { label: string; open?: boolean }) {
  // The gallery's secondary button (`Button`), as a plain view: the overlay
  // and the popover take its presses and anchor to it.
  const pointer = platform.idiom === "desktop";
  return (
    <View
      hoverStyle={props.open ? undefined : finish.hover}
      activeStyle={finish.pressed}
      style={{
        alignSelf: "flex-start",
        height: pointer ? 28 : 40,
        paddingHorizontal: pointer ? 12 : 16,
        justifyContent: "center",
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: 1,
        // What it opens is open: selected, as the shared `Button`'s.
        ...(props.open ? finish.pressed : finish.raised),
        transitionProperty: "background-color, border-color, box-shadow",
        transitionDuration: 120,
      }}
    >
      <Text style={{ fontSize: pointer ? 13 : 15, fontWeight: "500", color: colors.text }}>{props.label}</Text>
    </View>
  );
}

/**
 * Overlays: `<Overlay>` shows its children on top of the screen whatever
 * clips them, and `nsh/base`'s popups are built on it: a popover, a
 * tooltip (and the `tooltip` prop every element has), a sheet, toasts (menus have
 * a demo of their own, `Menus.tsx`).
 */
/** The overlays, one demo each in the sidebar. */
export type OverlayKind = "Overlay" | "Popover" | "Tooltip" | "Sheet" | "Toast";

export function Overlays(props: { show: OverlayKind }) {
  const last = signal("—");

  function Primitive() {
    const open = signal(false);
    const placement = signal<"bottom" | "top">("bottom");
    let anchor: ViewRef | undefined;
    return (
      <Card icon="components" title="Overlay" subtitle="A box that clips its content, with an overlay anchored inside it" right={<Badge label="nsh" />}>
        <View style={{ height: platform.idiom === "desktop" ? 48 : 56, overflow: "hidden", borderRadius: radius.inset, backgroundColor: colors.inset, justifyContent: "center", paddingHorizontal: 10 }}>
          <View ref={anchor} onPress={() => open.set(!open())} style={{ alignSelf: "flex-start" }}>
            <Trigger label={open() ? "Close" : "Open the overlay"} open={open()} />
          </View>
          <If when={open()}>
            <Overlay
              anchor={anchor}
              placement={placement()}
              align="start"
              offset={6}
              margin={8}
              onPressOutside={() => open.set(false)}
              onCancel={() => open.set(false)}
              onPosition={(e) => last.set(`overlay at ${e.placement}`)}
              style={popup()}
            >
              <Text style={{ fontSize: 14, color: colors.text, padding: 6 }}>Outside the clipped box, on top of the page.</Text>
            </Overlay>
          </If>
        </View>
        <Segmented options={[{ value: "bottom", label: "Below" }, { value: "top", label: "Above" }]} value={placement()} onChange={(p) => placement.set(p)} />
        <Caption label="Scroll the page: it follows its anchor; a press outside closes it" />
      </Card>
    );
  }

  function Popovers() {
    const shown = signal(false);
    return (
      <Card icon="components" title="Popover" subtitle="Anchored to its trigger on every device">
        <Popover
          offset={6}
          margin={8}
          popupStyle={popup()}
          onOpenChange={({ open, reason }) => {
            shown.set(open);
            last.set(`popover ${open ? "opened" : "closed"} (${reason})`);
          }}
          trigger={<Trigger label="Show the popover" open={shown()} />}
        >
          <View style={{ padding: 8, gap: 4, maxWidth: 260 }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>Popover</Text>
            <Text style={{ fontSize: 13, color: colors.muted }}>A press outside, Escape or back closes it.</Text>
          </View>
        </Popover>
      </Card>
    );
  }

  function Tooltips() {
    const hovered = signal(false);
    const pinned = signal(false);
    return (
      <Card icon="text" title="Tooltip" subtitle={platform.idiom === "desktop" ? "Rest the pointer on a button" : "Tooltips follow a pointer: pin one to see it"}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {/* A short text in a `Tooltip` of the gallery's look. */}
          <View tooltip={<Tip label="Saves the document" />}>
            <Button label="Save" variant="secondary" onPress={() => last.set("pressed Save")} />
          </View>
          {/* `Tooltip` of `nsh/base` as the tooltip: the bubble is the app's, and it reports. */}
          <View
            tooltip={
              <Tooltip
                open={pinned() || hovered()}
                onOpenChange={({ open, reason }) => {
                  hovered.set(open);
                  last.set(`tooltip ${open ? "shown" : "hidden"} (${reason})`);
                }}
                placement="bottom"
                delay={300}
                style={{ backgroundColor: colors.text, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}
              >
                <Text style={{ fontSize: 12, color: colors.background }}>Shown while pinned or hovered</Text>
              </Tooltip>
            }
          >
            <Button label={pinned() ? "Unpin the tooltip" : "Pin the tooltip"} variant="secondary" selected={pinned()} onPress={() => pinned.set(!pinned())} />
          </View>
        </View>
      </Card>
    );
  }

  function Sheets() {
    const open = signal(false);
    return (
      <Card icon="components" title="Sheet" subtitle="A panel at the bottom, over a backdrop">
        <Button label="Show the sheet" variant="secondary" selected={open()} onPress={() => open.set(true)} />
        <Sheet
          open={open()}
          onOpenChange={({ open: next, reason }) => {
            open.set(next);
            last.set(`sheet ${next ? "opened" : "closed"} (${reason})`);
          }}
          popupStyle={sheet()}
          backdropStyle={backdrop}
        >
          <View style={{ padding: 12, gap: 12 }}>
            <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text }}>Sheet</Text>
            <Text style={{ fontSize: 14, color: colors.muted }}>The backdrop, Escape and back close it.</Text>
            <Button label="Done" onPress={() => open.set(false)} />
          </View>
        </Sheet>
      </Card>
    );
  }

  function Toasts() {
    let count = 0;
    return (
      <Card icon="system" title="Toast" subtitle="The gallery's toasts, on ToastManager, ToastStack and Toast">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button
            label="Copy the link"
            variant="secondary"
            onPress={() => {
              count += 1;
              void toast({ title: "Copied", description: `The link is on the clipboard (${count})` });
            }}
          />
          <Button
            label="Delete the draft"
            variant="secondary"
            onPress={async () => {
              const answer = await toast({ id: "draft", title: "Draft deleted", action: "Undo", close: "×", duration: 8000 });
              last.set(answer === "Undo" ? "toast: undone" : "toast: gone");
            }}
          />
          <Button label="Dismiss all" variant="secondary" onPress={() => dismissToast()} />
        </View>
        <Caption label="Swipe one away; the pointer on one stops its time" />
      </Card>
    );
  }

  function Last() {
    return (
      <Card icon="system" title="Last event">
        <Text style={{ fontSize: 13, color: colors.text, fontFamily: mono }}>{last()}</Text>
      </Card>
    );
  }

  const cards = { Overlay: Primitive, Popover: Popovers, Tooltip: Tooltips, Sheet: Sheets, Toast: Toasts };
  return <DemoPage cards={[cards[props.show], Last]} />;
}

export const OverlayDemo = () => <Overlays show="Overlay" />;
export const PopoverDemo = () => <Overlays show="Popover" />;
export const TooltipDemo = () => <Overlays show="Tooltip" />;
export const SheetDemo = () => <Overlays show="Sheet" />;
export const ToastDemo = () => <Overlays show="Toast" />;
