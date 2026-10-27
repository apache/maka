import { effect, signal, Text, View } from "nsh";
import { createAnimatedValue } from "nsh";
import { Dialog, type TextViewImage } from "nsh/base";
import { safeArea } from "nsh";
import { Image } from "nsh";
import { motion, Press } from "./ui";

/** The deepest zoom, and where a double tap zooms in to. */
const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.5;
/** Two taps this close in time (ms) are a double tap. */
const DOUBLE_TAP_MS = 300;
/** A drag this far down (points) at 1× closes the viewer. */
const SWIPE_CLOSE = 120;

const clamp = (value: number, bound: number) => Math.max(-bound, Math.min(bound, value));

/**
 * A full-screen viewer for an image a `TextView` reports (`onImagePress`):
 * the image fitted over a dark scrim, fading and growing in. Pinch (two
 * fingers, a touchpad, or Ctrl / Cmd + wheel) zooms up to 4×, a double tap
 * or click toggles 2.5× at the point, a drag pans the zoomed image (at 1× a
 * drag down closes it). A press on the scrim, the close button, Escape and
 * the back button close it (`onClose`: set `image` to null). The alt text is
 * the caption.
 *
 * The gestures run natively (`pinch` / `pan` drive animated values on the
 * UI thread); JS only settles the result into bounds when one ends.
 */
export function ImageViewer(props: { image: TextViewImage | null; onClose: () => void }) {
  // The image stays while the dialog fades out.
  const shown = signal<TextViewImage | null>(null);
  const natural = signal<{ width: number; height: number } | null>(null);
  const viewport = signal({ width: 0, height: 0 });
  const scale = createAnimatedValue(1);
  const x = createAnimatedValue(0);
  const y = createAnimatedValue(0);
  const enter = createAnimatedValue(0);
  // Where the animated values settle, the gestures' starting points.
  let at = { scale: 1, x: 0, y: 0 };
  let lastTap = 0;
  let tap = { x: 0, y: 0 };
  let src = "";

  effect(() => {
    const image = props.image;
    if (!image) return;
    if (image.src !== src) natural.set(null);
    src = image.src;
    shown.set(image);
    at = { scale: 1, x: 0, y: 0 };
    scale.set(1);
    x.set(0);
    y.set(0);
    enter.set(0);
    enter.spring(1, motion.settle);
  });

  /** The image's box at 1×: its aspect ratio fitted into the viewport. */
  const box = () => {
    const v = viewport();
    const n = natural();
    if (!n || !n.width || !n.height || !v.width) return v;
    const k = Math.min(v.width / n.width, v.height / n.height);
    return { width: n.width * k, height: n.height * k };
  };

  /** Springs to `next`, within the zoom limits and the image's edges. */
  const settle = (next: { scale: number; x: number; y: number }) => {
    const s = Math.max(1, Math.min(MAX_ZOOM, next.scale));
    const b = box();
    const v = viewport();
    at = {
      scale: s,
      x: clamp(next.x, Math.max(0, (b.width * s - v.width) / 2)),
      y: clamp(next.y, Math.max(0, (b.height * s - v.height) / 2)),
    };
    scale.spring(at.scale, motion.settle);
    x.spring(at.x, motion.settle);
    y.spring(at.y, motion.settle);
  };

  /** A tap on the image: the second of two zooms in at the point, or out. */
  const pressImage = () => {
    const now = Date.now();
    if (now - lastTap > DOUBLE_TAP_MS) {
      lastTap = now;
      return;
    }
    lastTap = 0;
    if (at.scale > 1.01) return settle({ scale: 1, x: 0, y: 0 });
    // The tapped point (from the box's middle, unzoomed) stays under the finger.
    const b = box();
    const dx = tap.x - b.width / 2;
    const dy = tap.y - b.height / 2;
    settle({ scale: DOUBLE_TAP_ZOOM, x: at.x + (at.scale - DOUBLE_TAP_ZOOM) * dx, y: at.y + (at.scale - DOUBLE_TAP_ZOOM) * dy });
  };

  return (
    <Dialog
      open={!!props.image}
      animation="fade"
      style={{ flex: 1 }}
      statusBar={{ foreground: "light" }}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <View
        testID="image-viewer"
        focusable={false}
        onPress={props.onClose}
        onLayout={(e) => viewport.set({ width: e.size.width, height: e.size.height })}
        pinch={{ scale }}
        pan={{ x, y }}
        onPinchEnd={async () => settle({ ...at, scale: await scale.getValue() })}
        onPanEnd={(e) => {
          const dy = (e.valueY ?? at.y) - at.y;
          if (at.scale <= 1.01 && (dy > SWIPE_CLOSE || e.velocityY > 1200)) return props.onClose();
          settle({ scale: at.scale, x: e.valueX ?? at.x, y: e.valueY ?? at.y });
        }}
        style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.92)" }}
      >
        <View
          accessibilityLabel={shown()?.alt || "Image"}
          role="image"
          onTouchStart={(e) => (tap = { x: e.locationX, y: e.locationY })}
          onPress={pressImage}
          style={{
            width: box().width,
            height: box().height,
            opacity: enter,
            transform: [{ translateX: x }, { translateY: y }, { scale: scale.mul(enter.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] })) }],
          }}
        >
          <Image
            src={shown()?.src ?? ""}
            resizeMode="contain"
            onLoad={(e) => natural.set({ width: e.width, height: e.height })}
            style={{ width: "100%", height: "100%" }}
          />
        </View>
        {shown()?.alt ? (
          <View
            pointerEvents="none"
            style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingTop: 32, paddingBottom: safeArea().bottom + 20 }}
          >
            <Text style={{ fontSize: 14, lineHeight: 20, textAlign: "center", color: "rgba(255,255,255,0.85)" }}>{shown()?.alt}</Text>
          </View>
        ) : null}
        <View style={{ position: "absolute", top: safeArea().top + 12, right: safeArea().right + 12 }}>
          <Press onPress={props.onClose} accessibilityLabel="Close" scale={0.9} hitSlop={8}>
            <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.16)" }}>
              <View style={{ position: "absolute", width: 16, height: 2, borderRadius: 1, backgroundColor: "#ffffff", transform: [{ rotate: "45deg" }] }} />
              <View style={{ position: "absolute", width: 16, height: 2, borderRadius: 1, backgroundColor: "#ffffff", transform: [{ rotate: "-45deg" }] }} />
            </View>
          </Press>
        </View>
      </View>
    </Dialog>
  );
}
