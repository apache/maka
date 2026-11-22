package com.longbridge.nsh;

/**
 * The `focusable` decision, kept free of Android types so it is testable
 * on a plain JDK: `ViewProps::focus_stop`'s rule. Unset leaves the view a
 * stop when it takes presses; `true` makes any view one; `false` keeps it
 * out; a disabled view is never a stop.
 *
 * <p>Only an explicit `true` opts into touch-mode focus. A default
 * pressable stays a hardware/Tab focus stop: keyboard focus still reveals
 * it in its scroll view, while Android's touch-mode focus path never pulls
 * the focus out of an input or hosted view on a tap. A programmatic
 * `ref.focus()` is an explicit request of its own and opts in for the
 * focus it takes.
 */
final class Focusable {
    private Focusable() {}

    /** Whether a view with `prop` (-1 unset, 0 false, 1 true) is a Tab stop. */
    static boolean stop(int prop, boolean takesPresses, boolean enabled) {
        if (!enabled) return false;
        if (prop == 0) return false;
        if (prop == 1) return true;
        return takesPresses;
    }

    /** Whether a view with `prop` is focusable in touch mode: only an explicit `true` opts in. */
    static boolean touch(int prop) {
        return prop == 1;
    }

    /**
     * Whether a pointer press on a view with `prop` takes the focus, given
     * whether a text input or hosted native view has it (`nativeFocus`) and
     * whether the window is in touch mode. An explicit focusable always
     * takes it (it is focusable in touch mode). A default pressable takes
     * it only outside touch mode, where Android can focus it without
     * leaving the input's editing (a tap on a button must not hide its
     * keyboard).
     */
    static boolean pointer(int prop, boolean nativeFocus, boolean touchMode) {
        if (prop == 1) return true;
        return prop == -1 && !nativeFocus && !touchMode;
    }
}
