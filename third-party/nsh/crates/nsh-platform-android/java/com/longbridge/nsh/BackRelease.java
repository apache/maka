package com.longbridge.nsh;

/**
 * Back's press as a window's raw keys saw it, so that its release is
 * reported once although it may not come as a key-up through the views.
 *
 * <p>The window takes Back's release in one of three ways, after its down
 * went down the focus path ({@link KeyDispatch}): as a key-up there (Android
 * 8, or a press the app did not want); in {@code NshView}'s unhandled-key
 * listener, which then gets the press's repeats and release before any view
 * ({@code ViewRootImpl}'s {@code UnhandledKeyManager}); or, with an
 * {@code OnBackInvokedCallback} in effect, as {@code onBackInvoked} /
 * {@code onBackCancelled}, followed on Android 15 QPR1 to 16 by the key-up
 * marked cancelled. The first one to arrive is the release; a key-up of the
 * same press after it is not reported again.
 *
 * <p>Plain Java, no Android APIs, so its rules are tested on the JDK.
 */
final class BackRelease {
    private static final int IDLE = 0;
    /** A press went down and its release has not been reported. */
    private static final int HELD = 1;
    /** The press's release came another way; its key-up may still follow. */
    private static final int RELEASED = 2;

    private int state = IDLE;
    /** The press's down time ({@code KeyEvent.getDownTime}), which its key-up repeats. */
    private long downTime;

    /** A fresh press (repeat count 0) went down the focus path. */
    void press(long downTime) {
        this.downTime = downTime;
        state = HELD;
    }

    /** Whether a press is down and its release still to report. */
    boolean held() {
        return state == HELD;
    }

    /**
     * The release came another way than a key-up through the views: whether
     * to report it, true once per press.
     */
    boolean take() {
        if (state != HELD) return false;
        state = RELEASED;
        return true;
    }

    /**
     * A key-up went down the focus path: whether to report it. Only the
     * key-up of a press whose release was reported already is not; one
     * whose down went elsewhere is reported as any key's. A key-up of
     * another press leaves a held press held: its own release is still to
     * come.
     */
    boolean up(long downTime) {
        boolean same = downTime == this.downTime;
        boolean reported = state == RELEASED && same;
        if (state == RELEASED || same) state = IDLE;
        return !reported;
    }

    /** The window lost its focus or went away: no press is held. */
    void reset() {
        state = IDLE;
    }
}
