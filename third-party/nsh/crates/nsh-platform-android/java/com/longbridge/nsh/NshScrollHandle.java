package com.longbridge.nsh;

import android.view.View;

/**
 * A {@code <Scroll>} of the app, for native UI of the host that follows or
 * drives the app's scrolling in the frame of the scroll, without a round
 * trip through JS: a sheet under the content that the end of the content
 * pulls up, say. Get one from {@link NshView#watchScroll}. Both axes; lengths
 * are px, offsets from the start of the content. Call it on the UI thread.
 *
 * <p>The same API as iOS's {@code NshScrollHandle}. Once the scroll view is
 * deleted, loses its {@code nativeID} or its app stops, {@link #isAlive()} is
 * false, reads give 0 and the rest does nothing.
 */
public final class NshScrollHandle {
    private final ScrollBox box;
    private final String nativeId;

    NshScrollHandle(ScrollBox box, String nativeId) {
        this.box = box;
        this.nativeId = nativeId;
    }

    /** Whether the scroll view is still the app's, with the watched {@code nativeID}. */
    public boolean isAlive() {
        return !box.unmounted && nativeId.equals(box.hostKey);
    }

    /** The horizontal offset. */
    public int getScrollX() {
        return isAlive() ? box.hostScrollX() : 0;
    }

    /** The vertical offset. */
    public int getScrollY() {
        return isAlive() ? box.hostScrollY() : 0;
    }

    /** The content's width (at least the viewport's). */
    public int getContentWidth() {
        return isAlive() ? box.hostContentWidth() : 0;
    }

    /** The content's height (at least the viewport's). */
    public int getContentHeight() {
        return isAlive() ? box.hostContentHeight() : 0;
    }

    /** The visible width. */
    public int getViewportWidth() {
        return isAlive() ? box.hostViewportWidth() : 0;
    }

    /** The visible height. */
    public int getViewportHeight() {
        return isAlive() ? box.hostViewportHeight() : 0;
    }

    /**
     * The view holding the content: the positions of the views inside are
     * relative to it. Null once the scroll view is gone.
     */
    public View getContentView() {
        return isAlive() ? box.content : null;
    }

    /**
     * Scrolls by {@code dx}, {@code dy}, clamped to the content, as the
     * user's scroll would (the app's {@code onScroll} hears it);
     * {@code animated} uses the platform's animation.
     */
    public void scrollBy(int dx, int dy, boolean animated) {
        if (isAlive()) box.hostScrollBy(dx, dy, animated);
    }

    /** Ends a fling or an animated scroll where it is; nothing when at rest. */
    public void stopScrolling() {
        if (isAlive()) box.hostStop();
    }

    /** Calls {@code listener} on every offset and content size change, once per listener. */
    public void addScrollListener(NshScrollListener listener) {
        if (isAlive() && !box.hostListeners.contains(listener)) box.hostListeners.add(listener);
    }

    /** Stops calling {@code listener}. */
    public void removeScrollListener(NshScrollListener listener) {
        box.hostListeners.remove(listener);
    }
}
