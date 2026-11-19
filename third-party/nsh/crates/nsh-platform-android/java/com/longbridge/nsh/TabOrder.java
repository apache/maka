package com.longbridge.nsh;

/**
 * The next Tab stop from one stop of a window's ordered stops, kept free
 * of Android types for the plain-JDK test. The first and last stop yield
 * ({@code -1}) to the embedding Android host instead of wrapping: an app's
 * focus order must not trap Tab, so Android's own focus search and
 * defaults get that transition. `index` {@code -1} (nothing managed has the
 * focus, or the host itself does) starts at the first stop forward and the
 * last one backward.
 */
final class TabOrder {
    private TabOrder() {}

    /**
     * `index` moved one stop forward or backward among `size` stops;
     * `-1` when that leaves them, and when there are no stops at all.
     */
    static int next(int index, int size, boolean forward) {
        if (size <= 0) return -1;
        if (forward) {
            if (index < 0) return 0;
            return index + 1 < size ? index + 1 : -1;
        }
        if (index < 0) return size - 1;
        return index > 0 ? index - 1 : -1;
    }
}
