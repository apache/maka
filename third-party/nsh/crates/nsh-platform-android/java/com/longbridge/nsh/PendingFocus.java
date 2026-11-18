package com.longbridge.nsh;

/**
 * A `ref.focus()` waiting for its view to be shown, kept free of Android
 * types so it is testable on a plain JDK.
 *
 * <p>Android cannot focus a view that is not shown (`requestFocus` fails),
 * and an app focuses a control as its page or dialog opens: the page is
 * mounted in the batch that pushes it, before its stack places it, and a
 * transition shader hides it while it runs. The request is kept until the
 * view is shown instead of being dropped.
 *
 * <p>One request at a time, the latest winning: a newer `focus()`, a
 * `blur()` of the view (or of a view holding it, or `Keyboard.dismiss()`),
 * any view taking the focus meanwhile (the user's Tab or tap, or the view
 * itself) and the view's removal end it. A request whose view is still not
 * shown {@link #TIMEOUT_MS} after it was made is given up, so a view that
 * never shows does not keep it forever.
 */
final class PendingFocus {
    /** How long a request waits for its view: longer than a push or a dialog's fade. */
    static final long TIMEOUT_MS = 3000;

    /** {@link #retry}: nothing is pending. */
    static final int NONE = 0;
    /** {@link #retry}: the view is not shown yet; the request stays. */
    static final int WAIT = 1;
    /** {@link #retry}: the view is shown; focus it (the request is over). */
    static final int FOCUS = 2;
    /** {@link #retry}: the view was not shown in time; the request is dropped. */
    static final int EXPIRED = 3;

    /** The view waiting for the focus, 0 when none (node ids start at 1, the root, which is never a stop). */
    private int id;
    /** When it was asked for, in milliseconds of the caller's clock. */
    private long since;

    /** The view waiting for the focus, or 0. */
    int id() {
        return id;
    }

    /** Keeps a request for `id`, replacing an older one: the latest request wins. */
    void start(int id, long now) {
        this.id = id;
        since = now;
    }

    /** Ends the request, whatever it was for; returns that view's id (0: none was pending). */
    int clear() {
        int old = id;
        id = 0;
        return old;
    }

    /**
     * Whether a `blur()` of `blurred` ends the request for `target`: one of
     * the view itself, of a view holding it (`holdsTarget`, a dialog's
     * root included) or of the whole surface (`Keyboard.dismiss()`, the
     * root, id 1).
     */
    static boolean blurs(int blurred, int target, boolean holdsTarget) {
        if (target == 0) return false;
        return blurred == target || blurred == 1 || holdsTarget;
    }

    /**
     * Tries the request again, given whether its view is shown now and the
     * time: {@link #FOCUS} once it is shown, {@link #EXPIRED} once
     * {@link #TIMEOUT_MS} passed without that (both end the request),
     * {@link #WAIT} until then, {@link #NONE} when nothing is pending.
     */
    int retry(boolean shown, long now) {
        if (id == 0) return NONE;
        if (shown) {
            id = 0;
            return FOCUS;
        }
        if (now - since >= TIMEOUT_MS) {
            id = 0;
            return EXPIRED;
        }
        return WAIT;
    }
}
