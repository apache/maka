// The props domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import PropsGestureValues from "./props-gesture-values";
import PropsInputConfig from "./props-input-config";
import PropsListEvents from "./props-list-events";
import PropsListFollow from "./props-list-follow";
import PropsListLayout from "./props-list-layout";
import PropsListStart from "./props-list-start";
import PropsListStickyOffset from "./props-list-sticky-offset";
import PropsListViewport from "./props-list-viewport";
import PropsMediaImage from "./props-media-image";
import PropsMediaImageInline from "./props-media-image-inline";
import PropsMediaImageVariants from "./props-media-image-variants";
import PropsMediaSvg from "./props-media-svg";
import PropsMediaVideo from "./props-media-video";
import PropsMediaWebview from "./props-media-webview";
import PropsScrollBehavior from "./props-scroll-behavior";
import PropsScrollZoom from "./props-scroll-zoom";
import PropsTextLines from "./props-text-lines";
import PropsViewAccessibility from "./props-view-accessibility";
import PropsViewStyling from "./props-view-styling";
import PropsViewTouch from "./props-view-touch";

const cases: Record<string, () => JSX.Element> = {
  "props-gesture-values": PropsGestureValues,
  "props-input-config": PropsInputConfig,
  "props-list-events": PropsListEvents,
  "props-list-follow": PropsListFollow,
  "props-list-layout": PropsListLayout,
  "props-list-start": PropsListStart,
  "props-list-sticky-offset": PropsListStickyOffset,
  "props-list-viewport": PropsListViewport,
  "props-media-image": PropsMediaImage,
  "props-media-image-inline": PropsMediaImageInline,
  "props-media-image-variants": PropsMediaImageVariants,
  "props-media-svg": PropsMediaSvg,
  "props-media-video": PropsMediaVideo,
  "props-media-webview": PropsMediaWebview,
  "props-scroll-behavior": PropsScrollBehavior,
  "props-scroll-zoom": PropsScrollZoom,
  "props-text-lines": PropsTextLines,
  "props-view-accessibility": PropsViewAccessibility,
  "props-view-styling": PropsViewStyling,
  "props-view-touch": PropsViewTouch,
};
const shown = signal("");

mount(() => (
  <>
    {() => {
      const Case = cases[shown()];
      return Case ? <Case /> : null;
    }}
    <View style={{ position: "absolute", left: 0, top: 0, flexDirection: "row" }}>
      {Object.keys(cases).map(name => (
        <View testID={`case-${name}`} style={{ width: 1, height: 1 }} onPress={() => shown.set(name)} />
      ))}
    </View>
  </>
));
