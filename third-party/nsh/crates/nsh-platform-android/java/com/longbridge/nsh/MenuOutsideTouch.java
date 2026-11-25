package com.longbridge.nsh;

/**
 * What a touch outside a system menu's window does ({@link SystemMenus}):
 * the menu closes when a finger that went down outside it lifts, not when it
 * goes down. Plain Java, no Android APIs ({@code MenuOutsideTouchTest} runs
 * it on the JDK).
 *
 * <p>A {@code PopupWindow} that is outside-touchable closes on the press. A
 * gesture-navigation back swipe starts with that press at the screen's edge,
 * so the menu would close first and the swipe's back then go to the window
 * under it (a dialog), which closes too. The system takes a recognised swipe
 * from the window with {@code ACTION_CANCEL}: the menu then keeps its focus
 * and gets that back itself, closing alone, as the back button closes it. A
 * tap outside still closes the menu, on its release.
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/MenuOutsideTouch.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/MenuOutsideTouchTest.java
 * java -cp target/java-tests com.longbridge.nsh.MenuOutsideTouchTest
 * </pre>
 */
final class MenuOutsideTouch {
    /** The menu's own: the window handles the event as usual. */
    static final int PASS = 0;
    /** Part of a touch outside the menu: taken, nothing happens. */
    static final int TAKE = 1;
    /** A touch outside the menu lifted: taken, the menu closes. */
    static final int DISMISS = 2;

    // `MotionEvent`'s masked actions.
    static final int ACTION_DOWN = 0, ACTION_UP = 1, ACTION_CANCEL = 3;

    /** Whether the touch under way went down outside the menu. */
    private boolean outside;

    /**
     * What the menu's window does with an event whose masked action is
     * {@code action}; {@code out} is whether it lies outside the window.
     */
    int on(int action, boolean out) {
        switch (action) {
            case ACTION_DOWN:
                outside = out;
                return out ? TAKE : PASS;
            case ACTION_UP:
                if (!outside) return PASS;
                outside = false;
                return DISMISS;
            case ACTION_CANCEL:
                // The system took the touch (a back swipe): the menu stays.
                if (!outside) return PASS;
                outside = false;
                return TAKE;
            default:
                return outside ? TAKE : PASS;
        }
    }
}
