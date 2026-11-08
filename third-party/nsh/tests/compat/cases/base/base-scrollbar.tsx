// A case of the API's test suite (docs/dev/compatibility.md): `Scrollbar`
// of `nsh/base`, a scroll bar of the app's own look over a scroll view it
// names (`scroll`, the scroll view's ref) along its `axis`, with no look of
// its own: a press on its track scrolls the target so the thumb's middle
// is there and a drag goes on from there, the thumb no shorter than
// `minThumbLength`; it shows by its `mode` (`always`; `scrolling`: while
// the target scrolls, until `motion.idle` after), hidden taking no presses,
// and
// is labelled for screen readers (`accessibilityLabel`). The app's look of
// its track (`class`) and thumb (`thumbClass`, `thumbStyle`). Built in: a
// scroll view whose `scrollbar` is a theme of its own (`ScrollbarTheme`)
// shows that bar over its viewport, and `Scrollbar.setTheme` gives every
// scroll view whose `scrollbar` is `true` the app's (`null` takes it back);
// a multiline `Input` shows one over its text the same way.
// Where the target is told to scroll is how its script sees the presses.
import { cleanup, Scroll, View, type ViewRef } from "nsh";
import { Input, Scrollbar, type ScrollbarLook } from "nsh/base";

const look = (label: string): ScrollbarLook => ({
  class: "absolute inset-y-0 right-0 w-[10px]",
  thumbClass: "w-full",
  accessibilityLabel: label,
});

function App() {
  Scrollbar.setTheme({ mode: "always", vertical: look("App") });
  cleanup(() => Scrollbar.setTheme(null));
  let pages: ViewRef | undefined;
  let feed: ViewRef | undefined;
  let strip: ViewRef | undefined;
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 8 }}>
      <View style={{ width: 300, height: 200 }}>
        <Scroll ref={pages} testID="pages" scrollbar={false} style={{ flex: 1 }}>
          <View style={{ height: 1000 }} />
        </Scroll>
        <Scrollbar
          scroll={pages}
          mode="always"
          accessibilityLabel="Pages"
          class="absolute inset-y-0 right-0 w-[10px]"
          thumbClass="w-full"
          thumbStyle={{ backgroundColor: "#0000ff" }}
        />
      </View>
      <View style={{ width: 300, height: 100 }}>
        <Scroll ref={feed} testID="feed" scrollbar={false} style={{ flex: 1 }}>
          <View style={{ height: 1000 }} />
        </Scroll>
        <Scrollbar
          scroll={feed}
          motion={{ idle: 300, enter: 0, exit: 0, entrance: "fade", thumbHoverEntrance: "slideAndFade" }}
          minThumbLength={30}
          accessibilityLabel="Feed"
          class="absolute inset-y-0 right-0 w-[10px]"
          thumbClass="w-full"
        />
      </View>
      <View style={{ width: 200, height: 40 }}>
        <Scroll ref={strip} testID="strip" horizontal scrollbar={false} style={{ flex: 1 }}>
          <View style={{ width: 800, height: 40 }} />
        </Scroll>
        <Scrollbar
          scroll={strip}
          axis="horizontal"
          mode="always"
          accessibilityLabel="Strip"
          class="absolute inset-x-0 bottom-0 h-[6px]"
          thumbClass="h-full"
        />
      </View>
      <View style={{ width: 300, height: 100 }}>
        <Scroll testID="own" scrollbar={{ mode: "always", vertical: look("Own") }} style={{ flex: 1 }}>
          <View style={{ height: 1000 }} />
        </Scroll>
      </View>
      <View style={{ width: 300, height: 100 }}>
        <Input testID="notes" multiline scrollbar={{ mode: "always", vertical: look("Notes") }} style={{ flex: 1 }} />
      </View>
      <View style={{ width: 300, height: 100 }}>
        <Scroll testID="app" style={{ flex: 1 }}>
          <View style={{ height: 1000 }} />
        </Scroll>
      </View>
    </View>
  );
}

export default App;
