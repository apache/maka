package com.longbridge.nsh;

import java.util.function.BooleanSupplier;
import java.util.function.IntPredicate;

/**
 * Whether an arrow key moves the focus into the app, and to which stop,
 * kept free of Android types for the plain-JDK test. While no view of the
 * app has the focus, the window's own root holds it ({@code NshView}, or a
 * {@code ModalHost} dialog's container: at launch, and on the first key
 * after a tap, through their touch-mode listeners). Android's directional
 * search starts from that view and takes only views past its edge in the
 * key's direction; where it fills its window it finds nothing in any
 * direction, and the key does nothing until Tab moves the focus.
 *
 * <p>An arrow that nothing in the app took (no shortcut, no
 * {@code captureKeys} rule), that carries no modifier and that Android has
 * nowhere else to take (its focus search from the root finds no view
 * outside the app, and no scroll view around the app scrolls that way:
 * an embedded {@code NshView}'s host keeps the arrows it moved its own
 * focus or scrolled with) then moves the focus to the first stop on
 * screen and is consumed. That is near what Android's own default focus
 * picks when a navigation key finds no focused view ({@code ViewRootImpl}'s
 * {@code restoreDefaultFocus}: the first focusable in tree order, a scroll
 * view's first one below its scrolled top that is on screen), so the page
 * does not jump back to its start. Once a view of the app has the focus,
 * Android's own directional navigation moves it. Modified arrows (Shift to
 * extend a selection, Alt, Control, Meta) are left alone, as Android's
 * focus navigation leaves them; Enter, the D-pad centre and Tab are not
 * arrows.
 */
final class ArrowEntry {
    private ArrowEntry() {}

    /** {@code KeyEvent.KEYCODE_DPAD_UP}, which a keyboard's Up arrow reports too. */
    static final int DPAD_UP = 19;
    /** {@code KeyEvent.KEYCODE_DPAD_DOWN}. */
    static final int DPAD_DOWN = 20;
    /** {@code KeyEvent.KEYCODE_DPAD_LEFT}. */
    static final int DPAD_LEFT = 21;
    /** {@code KeyEvent.KEYCODE_DPAD_RIGHT}. */
    static final int DPAD_RIGHT = 22;

    /** {@code View.FOCUS_LEFT}. */
    static final int FOCUS_LEFT = 0x11;
    /** {@code View.FOCUS_UP}. */
    static final int FOCUS_UP = 0x21;
    /** {@code View.FOCUS_RIGHT}. */
    static final int FOCUS_RIGHT = 0x42;
    /** {@code View.FOCUS_DOWN}. */
    static final int FOCUS_DOWN = 0x82;

    /** Whether `code` is one of the four arrows (a keyboard's, a D-pad's or a gamepad's). */
    static boolean arrow(int code) {
        return code == DPAD_UP || code == DPAD_DOWN || code == DPAD_LEFT || code == DPAD_RIGHT;
    }

    /** The focus direction ({@code View.FOCUS_*}) of an arrow, 0 for another key. */
    static int direction(int code) {
        switch (code) {
            case DPAD_UP: return FOCUS_UP;
            case DPAD_DOWN: return FOCUS_DOWN;
            case DPAD_LEFT: return FOCUS_LEFT;
            case DPAD_RIGHT: return FOCUS_RIGHT;
            default: return 0;
        }
    }

    /**
     * Whether a key down of `code` that nothing in the app handled moves
     * the focus into the app: an arrow with no modifier
     * ({@code KeyEvent.hasNoModifiers}) while the window's own root holds
     * the focus (`rootFocused`: no view of the app has it), which Android
     * has nowhere else to take. `elsewhere` asks Android that (a focus
     * search, the scroll views around the app); it runs only when the rest
     * holds.
     */
    static boolean enters(int code, boolean noModifiers, boolean rootFocused, BooleanSupplier elsewhere) {
        return rootFocused && noModifiers && arrow(code) && !elsewhere.getAsBoolean();
    }

    /**
     * The stop an arrow into the app focuses, of `count` in tree order: the
     * first one `visible` (on screen in the window), or the first one when
     * none is; -1 when there are none.
     */
    static int stop(int count, IntPredicate visible) {
        for (int i = 0; i < count; i++) {
            if (visible.test(i)) return i;
        }
        return count > 0 ? 0 : -1;
    }
}
