package com.longbridge.nsh;

/** JNI entry points of libnsh.so (crates/nsh-platform-android/src/host.rs). */
final class Native {
    static {
        System.loadLibrary("nsh");
    }

    private Native() {}

    // Event kinds, in `nsh_core::EventKind` order.
    static final int PRESS = 0;
    static final int LONG_PRESS = 1;
    static final int PAN_START = 2;
    static final int PAN_END = 3;
    static final int REFRESH = 4;
    static final int LOAD_MORE = 5;
    static final int SCROLL_END = 6;
    static final int LOAD = 7;
    static final int ERROR = 8;
    static final int CHANGE_TEXT = 9;
    static final int SUBMIT_EDITING = 10;
    static final int FOCUS = 11;
    static final int BLUR = 12;
    static final int PRESS_IN = 13;
    static final int PRESS_OUT = 14;
    static final int LAYOUT = 15;
    static final int PINCH_START = 16;
    static final int PINCH_END = 17;
    static final int ROTATION_START = 18;
    static final int ROTATION_END = 19;
    static final int ACCESSIBILITY_ACTION = 20;
    static final int DISMISS = 21;
    static final int REQUEST_CLOSE = 22;
    static final int SHOW = 23;
    static final int INSETS = 24;
    static final int LOAD_START = 25;
    static final int MESSAGE = 26;
    static final int NAVIGATION_STATE_CHANGE = 27;
    static final int PROGRESS = 28;
    static final int END = 29;
    static final int BUFFER = 30;
    static final int VIEWABLE_ITEMS_CHANGE = 31;
    static final int BACK_PRESS = 32;
    static final int SCROLL = 33;
    static final int SCROLL_DRAG_START = 34;
    static final int SCROLL_DRAG_END = 35;
    static final int MOMENTUM_START = 36;
    static final int MOMENTUM_END = 37;
    static final int DIALOG = 38;
    static final int TOUCH = 39;
    static final int SELECTION_CHANGE = 40;
    static final int KEY_PRESS = 41;
    static final int LOAD_END = 42;
    static final int IMAGE_INFO = 43;
    static final int TEXT_LAYOUT = 44;
    static final int CONTENT_SIZE_CHANGE = 45;
    static final int BACK_REQUEST = 46;
    static final int NATIVE_EVENT = 47;
    static final int CLIPBOARD = 48;
    static final int KEY_COMMAND = 49;
    static final int HOVER_IN = 51;
    static final int HOVER_OUT = 52;
    static final int FILE_DRAG_ENTER = 53;
    static final int FILE_DRAG_LEAVE = 54;
    static final int FILE_DROP = 55;
    static final int HOVER_MOVE = 56;
    static final int CONTEXT_MENU = 57;
    static final int COMPOSITION_CHANGE = 58;
    static final int PRESS_OUTSIDE = 59;
    static final int CANCEL = 60;
    static final int POSITION = 61;
    static final int MOUSE_MOVE = 62;
    static final int SCROLL_INTENT = 63;
    static final int HOST = 64;
    static final int PICK = 65;
    static final int LOAD_MORE_AT_START = 66;
    static final int OPEN_URL = 67;
    static final int CARET_MOVE = 68;
    static final int PASTE = 69;

    /**
     * Draws the SVG {@code bytes} for a view {@code maxPx} pixels on its longer side, with its shorter side that long
     * (0: its intrinsic size, {@code density} pixels per point), as premultiplied RGBA, setting {@code size} to the
     * raster's width and height and the SVG's intrinsic size in whole points; {@code maxPx} below 0 only measures (an
     * empty array). {@code intrinsic} receives its unrounded width and height in points. Null when the bytes are
     * not a valid SVG. Any thread.
     */
    static native byte[] svg(byte[] bytes, int maxPx, float density, int[] size, float[] intrinsic);

    /**
     * A host whose apps keep their data in {@code dataDir} and the images they download in {@code cacheDir} (null:
     * not on disk), each in a directory named by its id.
     */
    static native long create(NshView view, float density, boolean trace, String dataDir, String cacheDir);

    static native void destroy(long handle);

    /** What loaded apps are granted at most (capabilities JSON; null: no ceiling); false if invalid. */
    static native boolean setGranted(long handle, String capabilities);

    /** VM limits of the apps loaded next (0 keeps a default). */
    static native void setLimits(long handle, int memoryMb, int stackKb, int loadMs, int callMs, int maxNodes);

    /** No VM limits for the apps loaded next: they run on their own. */
    static native void setStandaloneLimits(long handle);

    /** The directory the storage of the apps loaded next is kept in (null: each app's own in the data directory). */
    static native void setStorage(long handle, String dir);

    /**
     * Where the apps loaded next keep their caches ({@code location}: 0 the system's, 1 {@code dir}, 2 none) and how
     * much each keeps ({@code images}: 0 its default, 1 {@code imagesMaxMb} megabytes, 2 none).
     */
    static native void setCache(long handle, int location, String dir, int images, int imagesMaxMb);

    /**
     * What the running app's disk cache holds for {@code url}: its bytes ({@code byte[]}) when fresh, the conditional
     * request headers to revalidate a stale copy with ({@code String[]}, names and values), or null. Any thread.
     */
    static native Object imageCacheLookup(long handle, String url);

    /**
     * Ends a download of {@code url} through the disk cache: {@code status} 0 when the request failed, else the
     * response's status, {@code headers} (names and values) and body. Returns the cached bytes when they are what to
     * show (a 304; a stale copy when the request failed), or null. Any thread.
     */
    static native byte[] imageCacheComplete(long handle, String url, int status, String[] headers, byte[] body);

    /**
     * The embedding app's theme overrides (a shadcn/ui theme file, null: the
     * app's own theme). Returns why the file does not parse, or null.
     */
    static native String setThemeOverrides(long handle, String json);

    /** Whether the running app's web views may navigate to {@code url}. */
    static native boolean allowsWebview(long handle, String url);

    /**
     * The URL a media load redirected from {@code base} to {@code location}
     * goes on to, or null if the running app may not load it.
     */
    static native String mediaRedirect(long handle, String base, String location);

    /**
     * The bytes of the in-memory image {@code uri}: a {@code data:} URI's or a
     * {@code blob:} URL's that a view shows, or an {@code Image.getSize}
     * {@code data:} URI's; null when there are none.
     */
    static native byte[] imageBytes(long handle, String uri);

    /** {@code capabilities}: the app's declaration (JSON), {@code app}: its {@code app.json} ({@code id}); null for none. */
    static native void load(long handle, byte[] code, boolean bytecode, String sourceMap, String capabilities, String app);

    static native boolean connectDevServer(long handle, String url);

    /** Runs the Rust app this library is (defined by the app's `nsh::main!`; absent from the JS runtime's). */
    static native void runRust(long handle);

    /** A trust store kept in {@code dir}; 0 if its state cannot be read. */
    static native long trustCreate(String dir);

    static native boolean trustAddRoot(long trust, String publicKey);

    static native boolean trustUpdateRevocations(long trust, String json);

    static native void trustDestroy(long trust);

    /**
     * Verifies and unpacks a signed package (any thread): a package handle and
     * {@code info} = id, name, version, build; or 0 and {@code info[0]} = why.
     */
    static native long trustOpenPackage(long trust, String path, String[] info);

    /** Runs a package from {@link #trustOpenPackage}, taking it. */
    static native void runPackage(long handle, long pkg);

    static native void packageFree(long pkg);

    /** The images picked for pick {@code id} (none: cancelled); {@code sizes} holds each one's width and height in pixels. */
    static native void picked(long handle, int id, String[] names, String[] types, byte[][] data, int[] sizes);

    /** A native component emitted {@code name} with {@code json} data (null: none). */
    static native void componentEvent(long handle, int id, String name, String json);

    /** A native component's own size (dp). */
    static native void componentSize(long handle, int id, float width, float height);

    /** The launch parameters (a JSON object; null: none) of the apps loaded next; false if it is not one. */
    static native boolean setHostParams(long handle, String json);

    /** Sends event {@code name} with {@code json} data (null: none) to the running app; false if invalid. */
    static native boolean sendHostEvent(long handle, String name, String json);

    /** The app's calls and posts of {@code name} go to {@code NshView.hostMessage} ({@code handled}), or nowhere. */
    static native void setHostHandler(long handle, String name, boolean handled);

    /** Answers a call {@code hostMessage} got: {@code json}, or {@code error} when it failed. Frees it. */
    static native void hostReply(long call, String json, String error);

    /** Frees a call unanswered: it fails in the app. */
    static native void hostCallFree(long call);

    /** The URLs the app opens go to {@code NshView.openUrlMessage} first ({@code handled}), or to the system. */
    static native void setOpenUrlHandler(long handle, boolean handled);

    /** Answers a URL {@code openUrlMessage} got: whether the embedding app took it. Frees it. */
    static native void openUrlReply(long request, boolean handled);

    /** Root size in dp. */
    static native void resize(long handle, float width, float height);

    /**
     * values: safe area top, right, bottom, left, keyboard height, keyboard
     * animation duration (s), font scale, 1 if the language is right to left.
     * locale: the default locale's language tag (`Intl`'s default).
     */
    static native void environment(long handle, float[] values, boolean dark, String locale);

    static native void event(long handle, int id, int kind, String text, int count, float x, float y);

    /**
     * A hardware key went down: whether the app's shortcuts ({@code nsh/keymap}) take it.
     * {@code unicode}: what it types without modifiers ({@code KeyEvent.getUnicodeChar(0)});
     * {@code repeat}: an auto-repeat; {@code editing}: a text input or hosted view has the focus.
     */
    static native boolean keyDown(long handle, int keyCode, int unicode, int meta, boolean repeat, boolean editing);

    /** A hardware key went up: whether its press was taken (then so is its release). */
    static native boolean keyUp(long handle, int keyCode);

    /**
     * {@code onHoverMove} of view {@code id}: the pointer at ({@code x}, {@code y}) in it and at
     * ({@code pageX}, {@code pageY}) in its root view (dp); {@code modifiers}: 1 Ctrl, 2 Alt,
     * 4 Shift, 8 Meta.
     */
    static native void hover(long handle, int id, float x, float y, float pageX, float pageY, int modifiers);

    /**
     * Press event {@code kind} ({@code onPress}, {@code onLongPress}, {@code onPressDown},
     * {@code onPressUp}) of node {@code id}: the touch at ({@code x}, {@code y}) in the pressed
     * view and at ({@code pageX}, {@code pageY}) in its root view (dp); {@code modifiers} as
     * {@link #hover}'s; {@code clicks}: the click count.
     */
    static native void press(long handle, int id, int kind, float x, float y, float pageX, float pageY,
            int modifiers, int clicks);

    /**
     * An event with an object payload ({@code Double}, {@code Boolean} or
     * {@code String} values), or a single value when {@code keys} is null.
     */
    static native void eventMap(long handle, int id, int kind, String[] keys, Object[] values);

    /** `onPaste`: the pasted text, the images' encoded bytes and local files' {@code file:} URLs. */
    static native void paste(long handle, int id, String text, byte[][] images, String[] uris);

    /** Applies the animation items of batches up to {@code seq}; returns bound values. */
    static native float[] afterBatch(long handle, long seq);

    /** Actual native focus, innermost node first. */
    static native void focusPath(long handle, int[] path);

    /** The UI consumed this batch's retirement request, preserving any focused cell. */
    static native void retireListCell(long handle, long seq, int id, long request, boolean retired, int[] path);

    static native float[] tick(long handle, long frameNanos);

    /** Shader view {@code id} is {@code width} × {@code height} px; whether frames should come. */
    static native boolean shaderSize(long handle, int id, int width, int height);

    /**
     * A scroll view's offset, after applying {@code applied} of the scrolls
     * the core asked for. Returns bound values when a scroll value changed,
     * else null.
     */
    static native float[] scroll(long handle, int id, float x, float y, int applied);

    /**
     * How far (points) a vertical scroll view is pulled past its top.
     * Returns bound values when a pull value changed, else null.
     */
    static native float[] pull(long handle, int id, float distance);

    /**
     * A scroll view came to rest: the snapping animated values that follow it settle. Returns
     * bound values when one starts moving, else null.
     */
    static native float[] scrollEnded(long handle, int id);

    /** A zoomable scroll view's zoom scale, reported before its offset. */
    static native void zoom(long handle, int id, float scale);

    /**
     * Touches for the JS responder system. phase: 0 start, 1 move, 2 end,
     * 3 cancel. Per finger: id, target node, path length (in {@code paths},
     * innermost first), pageX, pageY, locationX, locationY (in
     * {@code coords}, dp) and whether it changed. {@code time}: ms.
     */
    static native void touch(long handle, int phase, int[] ids, int[] targets, int[] pathLengths, int[] paths,
            float[] coords, boolean[] changed, long time, int activated);

    static native boolean hasPan(long handle, int id);

    /** state: 0 began, 1 moved, 2 ended, 3 cancelled. */
    static native float[] pan(long handle, int id, int state, float tx, float ty, float vx, float vy);

    /** A pinch (scale) or two-finger rotation (degrees); state as for pan. */
    static native float[] transformGesture(long handle, int id, boolean rotation, int state, float amount, float velocity);

    /** The window of modal {@code id} is {@code width} x {@code height} dp. */
    static native void rootSize(long handle, int id, float width, float height, float top, float right, float bottom, float left);

    /** A display frame began after {@code NshView.requestJsFrame}. */
    static native void frame(long handle);

    /** Interaction states of view {@code id} the core tracks ({@code Mounter.STATE_*}). */
    static native void states(long handle, int id, int states);
}
