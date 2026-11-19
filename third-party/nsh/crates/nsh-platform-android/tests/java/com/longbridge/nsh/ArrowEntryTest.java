package com.longbridge.nsh;

/**
 * Coverage for the first arrow key while no view of the app has the focus:
 * an unmodified arrow that Android has nowhere else to take moves it into
 * the app, from the window's root only, to the first stop on screen. Plain
 * JDK, no Android APIs:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/ArrowEntry.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/ArrowEntryTest.java
 * java -cp target/java-tests com.longbridge.nsh.ArrowEntryTest
 * </pre>
 */
public final class ArrowEntryTest {
    // KeyEvent's codes of the keys that are not arrows.
    private static final int DPAD_CENTER = 23;
    private static final int TAB = 61;
    private static final int SPACE = 62;
    private static final int ENTER = 66;
    private static final int PAGE_DOWN = 93;
    private static final int MOVE_HOME = 122;
    private static final int DPAD_DOWN_LEFT = 269;

    public static void main(String[] args) {
        // Every arrow enters from the window's root when Android has
        // nowhere else to take it, whatever the direction.
        check("Down enters", ArrowEntry.enters(ArrowEntry.DPAD_DOWN, true, true, () -> false));
        check("Right enters", ArrowEntry.enters(ArrowEntry.DPAD_RIGHT, true, true, () -> false));
        check("Up enters", ArrowEntry.enters(ArrowEntry.DPAD_UP, true, true, () -> false));
        check("Left enters", ArrowEntry.enters(ArrowEntry.DPAD_LEFT, true, true, () -> false));

        // An embedded surface with a host view in the arrow's direction, or
        // a host scroll view scrolling that way: the host keeps the arrow.
        check("an arrow Android takes elsewhere does not enter",
                !ArrowEntry.enters(ArrowEntry.DPAD_UP, true, true, () -> true));

        // A focused view of the app: Android's directional navigation moves it.
        check("Down from a focused view is Android's",
                !ArrowEntry.enters(ArrowEntry.DPAD_DOWN, true, false, () -> false));
        check("Up from a focused view is Android's",
                !ArrowEntry.enters(ArrowEntry.DPAD_UP, true, false, () -> false));

        // A modifier (Shift extends a selection, Alt / Control / Meta are
        // shortcuts) leaves the arrow alone, as Android's focus navigation does.
        check("a modified arrow does not enter",
                !ArrowEntry.enters(ArrowEntry.DPAD_DOWN, false, true, () -> false));

        // Only the four arrows: Enter and the centre key keep Android's
        // default, Tab has its own traversal, and the other navigation keys
        // are not focus moves.
        int[] others = {ENTER, DPAD_CENTER, SPACE, TAB, PAGE_DOWN, MOVE_HOME, DPAD_DOWN_LEFT};
        for (int code : others) {
            check("key " + code + " does not enter", !ArrowEntry.enters(code, true, true, () -> false));
            check("key " + code + " has no direction", ArrowEntry.direction(code) == 0);
        }

        // Android's search runs only for an arrow that would enter: no focus
        // search for other keys, modified arrows or a focused view.
        ArrowEntry.enters(ENTER, true, true, ArrowEntryTest::unasked);
        ArrowEntry.enters(ArrowEntry.DPAD_DOWN, false, true, ArrowEntryTest::unasked);
        ArrowEntry.enters(ArrowEntry.DPAD_DOWN, true, false, ArrowEntryTest::unasked);

        // Each arrow searches in its own direction (View.FOCUS_*).
        check("Up searches up", ArrowEntry.direction(ArrowEntry.DPAD_UP) == 0x21);
        check("Down searches down", ArrowEntry.direction(ArrowEntry.DPAD_DOWN) == 0x82);
        check("Left searches left", ArrowEntry.direction(ArrowEntry.DPAD_LEFT) == 0x11);
        check("Right searches right", ArrowEntry.direction(ArrowEntry.DPAD_RIGHT) == 0x42);

        // The stop entered: the first one on screen, so a scrolled page
        // stays where it is; the first one when none is on screen; none
        // without stops.
        check("the first stop when it is on screen", ArrowEntry.stop(4, i -> true) == 0);
        check("the first stop on screen of a scrolled page", ArrowEntry.stop(6, i -> i >= 3) == 3);
        check("the first on screen, not a later one", ArrowEntry.stop(6, i -> i == 2 || i == 4) == 2);
        check("the first stop when none is on screen", ArrowEntry.stop(3, i -> false) == 0);
        check("no stop without stops", ArrowEntry.stop(0, i -> true) == -1);
        System.out.println("ArrowEntryTest: ok");
    }

    private static boolean unasked() {
        throw new AssertionError("asked Android about a key that does not enter");
    }

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError(what);
    }
}
