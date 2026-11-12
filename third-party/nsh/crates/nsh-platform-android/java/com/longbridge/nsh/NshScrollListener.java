package com.longbridge.nsh;

/**
 * Hears a scroll view the host watches ({@link NshScrollHandle#addScrollListener}),
 * on the UI thread, in the frame of the change.
 */
public interface NshScrollListener {
    /**
     * The offset changed: the user's scroll, a fling, the app's or the
     * host's.
     *
     * @param scrollX the horizontal offset, in px
     * @param scrollY the vertical offset, in px
     * @param dx the horizontal change since the last call, in px (positive:
     *     the content moved left)
     * @param dy the vertical change since the last call, in px (positive:
     *     the content moved up)
     */
    void onScroll(int scrollX, int scrollY, int dx, int dy);

    /**
     * The content got larger or smaller without a scroll (data arrived, a
     * section opened): what depends on where the content ends moves.
     *
     * @param contentWidth the content's width, in px (at least the viewport's)
     * @param contentHeight the content's height, in px (at least the
     *     viewport's)
     */
    default void onContentSizeChange(int contentWidth, int contentHeight) {}
}
