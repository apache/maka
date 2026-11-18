package com.longbridge.nsh;

/**
 * The keyboard ancestry choice for one mounted view: a mounted
 * {@code ViewProps.key_parent} routing override wins over the logical
 * host parent and the native Insert parent. That override is how a
 * portaled view (an Overlay inserted at the root while its Node.parent is
 * elsewhere) keeps its real keyboard ancestors; a native Insert is never
 * proof of logical ancestry. Kept free of Android types for the plain-JDK
 * test.
 */
final class KeyAncestry {
    private KeyAncestry() {}

    /** The logical keyboard parent: `override`, else `host`, else `physical`; `-1` for none. */
    static int parent(int override, int host, int physical) {
        if (override >= 0) return override;
        if (host >= 0) return host;
        return physical;
    }
}
