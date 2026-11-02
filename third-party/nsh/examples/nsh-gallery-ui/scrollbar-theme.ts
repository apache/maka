import { platform } from "nsh";
import type { ScrollbarTheme } from "nsh/base";

const touch = !platform.desktop;

/**
 * The gallery's scroll bars, gpui-component's, which `Scrollbar.setTheme`
 * gives every scroll view and list in place of the platform's indicator.
 * They show while the content scrolls and while the pointer is over them
 * (pointing at a hidden thumb slides it in from the edge), fade in over
 * 300 ms and out over 500 ms, 2 s after the last scroll, drag or hover.
 * The track is 16 points thick over the view's edge (the widest thumb and
 * an inset of 4 on each side, 2 on a touch screen); the thumb is 6 points
 * at rest (3, the system's indicator, on a touch screen), 8 and darker
 * under the pointer or while dragged, its width easing over 300 ms. Its
 * colors are opaque, the muted foreground mixed into the background (as
 * gpui-component's themes do), so rows never show through it.
 */
export const scrollbarTheme: ScrollbarTheme = {
  mode: "hover",
  motion: { idle: 2000, enter: 300, exit: 500, entrance: "fade", thumbHoverEntrance: "slideAndFade" },
  vertical: {
    class: `absolute inset-y-0 right-0 w-4 items-end ${touch ? "p-0.5" : "p-1"}`,
    thumbClass: `${touch ? "w-[3px]" : "w-1.5"} rounded-full bg-scrollbar-thumb transition-all duration-300 hover:w-2 hover:bg-scrollbar-thumb-hover active:w-2 active:bg-scrollbar-thumb-hover motion-reduce:transition-none`,
  },
  horizontal: {
    class: `absolute inset-x-0 bottom-0 h-4 items-end ${touch ? "p-0.5" : "p-1"}`,
    thumbClass: `${touch ? "h-[3px]" : "h-1.5"} rounded-full bg-scrollbar-thumb transition-all duration-300 hover:h-2 hover:bg-scrollbar-thumb-hover active:h-2 active:bg-scrollbar-thumb-hover motion-reduce:transition-none`,
  },
};
