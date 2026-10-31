import { Overlay, signal, Text, View, type ViewRef } from "nsh";
import { platform } from "nsh";
import { Badge, Caption, Card, colors, DemoPage, finish, mono, PopIn, popupSurface, radius, Segmented } from "../ui";

export { Popovers as PopoverDemo } from "./Popovers";
export { Tooltips as TooltipDemo } from "./Tooltips";
export { Sheets as SheetDemo } from "./Sheets";
export { Toasts as ToastDemo } from "./Toasts";

/** A pressable chip that opens a popup. */
function Trigger(props: { label: string; open?: boolean }) {
  // The gallery's secondary button (`Button`), as a plain view: the overlay
  // and the popover take its presses and anchor to it.
  const pointer = platform.desktop;
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
 * `<Overlay>`: its children on top of the screen whatever clips them,
 * anchored to an element; `nsh/base`'s popups are built on it (their demos:
 * `Popovers.tsx`, `Tooltips.tsx`, `Sheets.tsx`, `Toasts.tsx`, `Menus.tsx`).
 */
export function OverlayDemo() {
  const last = signal("—");

  function Primitive() {
    const open = signal(false);
    const placement = signal<"bottom" | "top">("bottom");
    let anchor: ViewRef | undefined;
    return (
      <Card icon="components" title="Overlay" subtitle="A box that clips its content, with an overlay anchored inside it" right={<Badge label="nsh" />}>
        <View style={{ height: platform.desktop ? 48 : 56, overflow: "hidden", borderRadius: radius.inset, backgroundColor: colors.inset, justifyContent: "center", paddingHorizontal: 10 }}>
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
            >
              <PopIn side={placement()} style={{ ...popupSurface(), padding: 6, minWidth: 180 }}>
                <Text style={{ fontSize: 14, color: colors.text, padding: 6 }}>Outside the clipped box, on top of the page.</Text>
              </PopIn>
            </Overlay>
          </If>
        </View>
        <Segmented options={[{ value: "bottom", label: "Below" }, { value: "top", label: "Above" }]} value={placement()} onChange={(p) => placement.set(p)} />
        <Caption label="Scroll the page: it follows its anchor; a press outside closes it" />
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

  return <DemoPage cards={[Primitive, Last]} />;
}
